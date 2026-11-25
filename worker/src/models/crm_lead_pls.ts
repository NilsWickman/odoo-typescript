/**
 * crm.lead predictive lead scoring and the won/lost side of the lead (odoo/addons/crm/models/crm_lead.py):
 *  - `_compute_probabilities` (:508-516) over `_pls_get_naive_bayes_probabilities` (:2174-2350) and
 *    `_pls_get_lead_pls_values` (:2709-2789, ORM mode for the compute, SQL mode for the frequency update),
 *    registered as the record computes of `automated_probability` and `probability`;
 *  - `_handle_won_lost` (:905-952) with `_pls_increment_frequencies` (:2353), `_pls_prepare_update_frequency_table`
 *    (:2478), `_pls_update_frequency_table` (:2567), `_pls_prepare_frequencies` (:2655) and
 *    `_pls_increment_frequency_dict` (:2698): exported for the crm.lead create/write overrides;
 *  - the buttons `action_unarchive` (:1031), `action_set_automated_probability` (:1083), `action_restore` (:1042),
 *    `action_set_lost` (:1051), `action_set_won`
 *    (:1057), `action_set_won_rainbowman` (:1089), `get_rainbowman_message` (:1105, `_get_rainbowman_message` :1111).
 *
 * The Python compute assigns both fields in one method; the port computes them one by one, so `probability` needs the
 * values both fields had before the recomputation (`was_automated`, :513). For a new record these are `prev()`; for a
 * database record recomputed by the queue, `automated_probability` may already be written when `probability` is
 * computed, so its compute leaves the old values in the request cache for the other one (`OLD_KEY`).
 */
import { AccessError, NotPorted, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { checkModelAccess } from "../orm/access";
import { cond, or, and, TRUE } from "../orm/domain";
import { envCache, userInfo } from "../orm/env";
import { DbRec, NewRec, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Domain, Environment } from "../orm/types";
import { create } from "../orm/create";
import { write } from "../orm/write";
import { ModelImpl } from "../orm/model";
import { plainNumber } from "../orm/values";
import { dbNow, translate, validTz } from "./util";
import { setHandleWonLost } from "./crm_lead_write";
import { withLeadTracking } from "./crm_lead_mail";

const MODEL = "crm.lead";

// ------------------------------------------------------------------------------------------------ config

async function configStr(env: Environment, key: string): Promise<string | null> {
  return envCache(env, `crm.pls.icp:${key}`, async () =>
    (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = $1", [key])).rows[0]?.value ?? null);
}

/** `_pls_get_safe_fields` (:2626): crm.pls_fields restricted to fields of the model. */
async function safeFields(env: Environment): Promise<string[]> {
  const raw = await configStr(env, "crm.pls_fields");
  const fields = raw ? raw.split(",") : [];
  const def = env.reg.model(MODEL);
  return fields.filter((f) => def.fields.has(f));
}

/** `_pls_get_safe_start_date` (:2615): the crm.pls_start_date string when it is a valid date (`Date.to_date`). */
async function safeStartDate(env: Environment): Promise<string | null> {
  const raw = await configStr(env, "crm.pls_start_date");
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw.slice(0, 10)) || Number.isNaN(Date.parse(raw.slice(0, 10)))) return null;
  return raw;
}

/** `["stage_id", "team_id"] + safe fields`, tag_ids taken out (:2726-2732). */
async function plsFields(env: Environment): Promise<{ fields: string[]; useTags: boolean }> {
  const fields = ["stage_id", "team_id", ...(await safeFields(env))];
  const i = fields.indexOf("tag_ids");
  if (i >= 0) fields.splice(i, 1);
  return { fields, useTags: i >= 0 };
}

// ------------------------------------------------------------------------------------------------ values

type PlsValue = number | string | boolean;
interface LeadValues { values: [string, PlsValue][]; team_id: number | false }

/** Python `str()` of a pls value (`_pls_increment_frequency_dict` and the frequency lookup use strings). */
function pyStr(v: PlsValue): string {
  if (v === true) return "True";
  if (v === false) return "False";
  return String(v);
}

function idOf(v: unknown): number | false {
  if (typeof v === "number") return v;
  if (v instanceof DbRec) return v.id;
  if (v instanceof NewRec) throw new NotPorted("predictive lead scoring on a new related record");
  return false;
}

/** `_pls_get_lead_pls_values()` without domain (:2775-2789): the lead's values through the ORM. */
async function recPlsValues(env: Environment, rec: Rec): Promise<LeadValues> {
  const { fields, useTags } = await plsFields(env);
  const def = env.reg.model(MODEL);
  const values: [string, PlsValue][] = [];
  for (const field of fields) {
    if (field === "team_id") continue;
    const f = def.fields.get(field)!;
    let value: PlsValue;
    if (f.type === "many2one") value = idOf(await rec.get(field));
    else if (f.type === "one2many" || f.type === "many2many") throw new NotPorted(`PLS field ${field}`);
    else {
      const raw = await rec.get(field);
      value = raw === null || raw === undefined ? false : (raw as PlsValue);
    }
    if (value || field === "email_state" || field === "phone_state") values.push([field, value]);
  }
  if (useTags) for (const tag of await rec.rels("tag_ids")) values.push(["tag_id", tag.id ?? 0]);
  return { values, team_id: idOf(await rec.get("team_id")) };
}

// ------------------------------------------------------------------------------------------------ naive Bayes

interface Count { won: number; lost: number }
type FieldResult = { won_total: number; lost_total: number; values: Map<string, Count> };
interface TeamResult { fields: Map<string, FieldResult>; team_won: number; team_lost: number; team_total: number }

/**
 * Python `round(x, 2)`: correctly rounded on the exact value of the double, exact ties to even (CPython
 * float_round via _Py_dg_dtoa). `toFixed` also rounds the exact value but breaks exact ties upwards, so a value such
 * as 65.625 (exactly representable) must round to 65.62, not 65.63.
 */
function round2(x: number): number {
  const exact = Math.abs(x).toFixed(60);
  const m = /^(\d+)\.(\d\d)5(0*)$/.exec(exact);
  if (m !== null) {
    const cents = Number(m[1]) * 100 + Number(m[2]);
    const even = cents % 2 === 0 ? cents : cents + 1;
    return Math.sign(x) * (even / 100);
  }
  return Number(x.toFixed(2));
}

/**
 * `_pls_get_naive_bayes_probabilities` (:2174-2350) for leads given as values (the ORM mode of the compute). Leads
 * without a result keep their value (the compute only assigns the leads it got a probability for).
 */
async function naiveBayes(env: Environment, leads: readonly LeadValues[]): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (!leads.length) return out;
  const sudo = env.sudo();
  const wonStageIds = new Set(await sudo.model("crm.stage").search(cond("is_won", "=", true)));
  const wonLeads = new Set<number>();
  const fieldSet = new Set<string>();
  leads.forEach((lead, i) => {
    for (const [field, value] of lead.values) {
      if (field === "stage_id" && typeof value === "number" && wonStageIds.has(value)) wonLeads.add(i);
      fieldSet.add(field);
    }
  });
  const leadsFields = [...fieldSet].sort();
  const freqModel = sudo.model("crm.lead.scoring.frequency");
  const freqIds = await freqModel.search(cond("variable", "in", leadsFields), { order: "team_id asc, id" });
  const freqs = freqIds.length ? await freqModel.read(freqIds, ["variable", "value", "won_count", "lost_count", "team_id"], "") : [];
  const byId = new Map(freqs.map((f) => [Number(f["id"]), f]));

  const emptyTeam = (): TeamResult => ({
    fields: new Map(leadsFields.map((f) => [f, { won_total: 0, lost_total: 0, values: new Map<string, Count>() }])),
    team_won: 0, team_lost: 0, team_total: 0,
  });
  const result = new Map<number, TeamResult>();
  for (const id of freqIds) {
    const t = byId.get(id)?.["team_id"];
    if (typeof t === "number" && !result.has(t)) result.set(t, emptyTeam());
  }
  result.set(-1, emptyTeam());
  for (const id of freqIds) {
    const f = byId.get(id)!;
    const field = String(f["variable"]);
    const value = String(f["value"]);
    const won = num(f["won_count"]);
    const lost = num(f["lost_count"]);
    // :2283-2285: tags with less than 50 won+lost are ignored
    if (field === "tag_id" && won + lost < 50) continue;
    const team = f["team_id"];
    if (typeof team === "number") {
      const tr = result.get(team)!.fields.get(field)!;
      tr.values.set(value, { won, lost });
      tr.won_total += won;
      tr.lost_total += lost;
    }
    const all = result.get(-1)!.fields.get(field)!;
    const cur = all.values.get(value) ?? { won: 0, lost: 0 };
    cur.won += won;
    cur.lost += lost;
    all.values.set(value, cur);
    all.won_total += won;
    all.lost_total += lost;
  }
  // _pls_get_won_lost_total_count (:2638): the first stage without team carries every won and lost count
  const firstStage = (await sudo.model("crm.stage").search(cond("team_ids", "=", false), { order: "sequence, id", limit: 1 }))[0];
  for (const tr of result.values()) {
    const stage = firstStage === undefined ? undefined : tr.fields.get("stage_id")?.values.get(String(firstStage));
    if (stage === undefined) { tr.team_won = 0; tr.team_lost = 0; tr.team_total = 0; continue; }
    tr.team_won = stage.won;
    tr.team_lost = stage.lost;
    tr.team_total = stage.won + stage.lost;
  }

  let saveTeam: number | null = null;
  let pWon = 1, pLost = 1, teamWon = 0, teamLost = 0;
  leads.forEach((lead, i) => {
    if (!lead.values.some(([f]) => f === "stage_id")) { out.set(i, 0); return; }
    if (wonLeads.has(i)) { out.set(i, 100); return; }
    const leadTeam = typeof lead.team_id === "number" && result.has(lead.team_id) ? lead.team_id : -1;
    if (leadTeam !== saveTeam) {
      saveTeam = leadTeam;
      const tr = result.get(saveTeam)!;
      teamWon = tr.team_won;
      teamLost = tr.team_lost;
      // :2323-2324: no probability when one count is 0 (p_won/p_lost keep their previous values)
      if (!teamWon || !teamLost) return;
      pWon = teamWon / tr.team_total;
      pLost = teamLost / tr.team_total;
    }
    let sWon = pWon, sLost = pLost;
    for (const [field, value] of lead.values) {
      const fr = result.get(saveTeam)?.fields.get(field);
      const vr = fr?.values.get(pyStr(value));
      if (!fr || !vr) continue;
      const totalWon = field === "stage_id" ? teamWon : fr.won_total;
      const totalLost = field === "stage_id" ? teamLost : fr.lost_total;
      if (!totalWon || !totalLost) continue;
      sWon *= vr.won / totalWon;
      sLost *= vr.lost / totalLost;
    }
    const probability = sWon / (sWon + sLost);
    out.set(i, Math.min(Math.max(round2(100 * probability), 0.01), 99.99));
  });
  return out;
}

// ------------------------------------------------------------------------------------------------ computes

function num(v: unknown): number {
  const n = plainNumber(v);
  return typeof n === "number" ? n : 0;
}

/** `float_compare(a, b, 2) == 0` (tools/float_utils.py: compare the difference rounded to 2 digits). */
function floatEqual2(a: number, b: number): boolean {
  return Math.abs(Math.round((a - b) * 100)) === 0;
}

const OLD_KEY = (id: number): string => `crm.pls.old:${id}`;
const PROB_DONE_KEY = (id: number): string => `crm.pls.probability_done:${id}`;

/** The automated probability of one lead, or undefined when the compute leaves it unchanged. */
async function leadProbability(env: Environment, rec: Rec): Promise<number | undefined> {
  return (await naiveBayes(env, [await recPlsValues(env, rec)])).get(0);
}

registerRecordCompute(MODEL, {
  // :508-516
  automated_probability: async (env, rec) => {
    const oldAuto = num(await rec.prev("automated_probability"));
    if (rec instanceof DbRec) {
      if (env.cache.has(PROB_DONE_KEY(rec.id))) env.cache.delete(PROB_DONE_KEY(rec.id));
      else env.cache.set(OLD_KEY(rec.id), { auto: oldAuto, prob: num(await rec.prev("probability")) });
    }
    const p = await leadProbability(env, rec);
    return p === undefined ? oldAuto : p;
  },
  probability: async (env, rec) => {
    const oldProb = num(await rec.prev("probability"));
    let oldAuto = num(await rec.prev("automated_probability"));
    if (rec instanceof DbRec) {
      const saved = env.cache.get(OLD_KEY(rec.id)) as { auto: number; prob: number } | undefined;
      if (saved !== undefined) {
        env.cache.delete(OLD_KEY(rec.id));
        if (saved.prob === oldProb) oldAuto = saved.auto;
      } else {
        env.cache.set(PROB_DONE_KEY(rec.id), true);
      }
    }
    const p = await leadProbability(env, rec);
    if (p === undefined) return oldProb;
    // was_automated = lead.active and lead.is_automated_probability (:513, :501-506)
    const wasAutomated = (await rec.get("active")) === true && floatEqual2(oldProb, oldAuto);
    return wasAutomated ? p : oldProb;
  },
});

// ------------------------------------------------------------------------------------------------ frequencies

// crm/models/crm_lead_scoring_frequency.py: no `default=` on the fields
registerDefaults("crm.lead.scoring.frequency", {});

export interface WonLostStatus { readonly is_lost: boolean; readonly is_won: boolean }

/** `_pls_get_lead_pls_values(domain=[('id', 'in', ids)])` (:2735-2774): SQL mode, ordered by team_id asc, id desc. */
async function sqlPlsValues(env: Environment, ids: readonly number[]): Promise<Map<number, LeadValues>> {
  const { fields, useTags } = await plsFields(env);
  const cols = fields.map((f) => `"${f.replace(/"/g, "")}"`);
  const rows = (await env.cr.query<Record<string, unknown>>(
    `SELECT id, probability, ${cols.join(", ")} FROM crm_lead WHERE id = ANY($1::int[]) ORDER BY team_id ASC, id DESC`, [ids])).rows;
  const out = new Map<number, LeadValues>();
  for (const row of rows) {
    const values: [string, PlsValue][] = [];
    for (const field of [...fields, "probability"]) {
      if (field === "team_id") continue;
      const raw = row[field];
      const value: PlsValue | null = raw === null || raw === undefined ? null : typeof raw === "string" && field === "probability" ? Number(raw) : (raw as PlsValue);
      if ((value !== null && value !== false && value !== "" && value !== 0) || field === "probability") values.push([field, value ?? false]);
      else if (field === "email_state" || field === "phone_state") values.push([field, false]);
    }
    out.set(Number(row["id"]), { values, team_id: typeof row["team_id"] === "number" ? row["team_id"] : false });
  }
  if (useTags) {
    const tags = (await env.cr.query<{ lead_id: number; tag_id: number }>(
      `SELECT l.id AS lead_id, r.tag_id FROM crm_lead l JOIN crm_tag_rel r ON r.lead_id = l.id
       WHERE l.id = ANY($1::int[]) ORDER BY l.team_id ASC, l.id DESC`, [ids])).rows;
    for (const t of tags) if (t.tag_id) out.get(t.lead_id)?.values.push(["tag_id", t.tag_id]);
  }
  return out;
}

type Frequencies = Map<string, Map<string, Count>>;

/** `_pls_increment_frequency_dict` (:2698). */
function incrementFrequency(freq: Frequencies, field: string, value: PlsValue, won: number, lost: number): void {
  const key = pyStr(value);
  const m = freq.get(field)!;
  const cur = m.get(key);
  if (cur === undefined) m.set(key, { won, lost });
  else { cur.won += won; cur.lost += lost; }
}

/** `_pls_increment_frequencies(from_state, to_state)` (:2353) for the leads `ids`. */
async function incrementFrequencies(env: Environment, ids: readonly number[], fromState: string | null, toState: string | null): Promise<void> {
  if (!ids.length) return;
  const targetState = fromState ?? toState;
  // _pls_prepare_update_frequency_table (:2478-2565), increment mode
  const start = await safeStartDate(env);
  if (!start) return;
  const created = (await env.cr.query<{ id: number; d: string }>(
    "SELECT id, create_date::date::text AS d FROM crm_lead WHERE id = ANY($1::int[])", [ids])).rows;
  const plsIds = ids.filter((id) => { const d = created.find((r) => r.id === id)?.d; return d !== undefined && start.slice(0, 10) <= d; });
  if (!plsIds.length) return;
  const leadValues = await sqlPlsValues(env, plsIds);
  // pls_leads.mapped('team_id').ids + [0], in the order of the leads
  const teamOrder: number[] = [];
  const teamRows = (await env.cr.query<{ id: number; team_id: number | null }>(
    "SELECT id, team_id FROM crm_lead WHERE id = ANY($1::int[])", [plsIds])).rows;
  const teamOf = new Map(teamRows.map((r) => [r.id, r.team_id]));
  for (const id of plsIds) { const t = teamOf.get(id); if (t && !teamOrder.includes(t)) teamOrder.push(t); }
  const teamIds = [...teamOrder, 0];
  const byTeam = new Map<number, Record<string, PlsValue | number>[]>(teamIds.map((t) => [t, []]));
  const fieldSet = new Set<string>();
  for (const lv of leadValues.values()) {
    const team = lv.team_id || 0;
    const entry: Record<string, PlsValue | number> = { count: 1 };
    let leadProbability: PlsValue = 0;
    for (const [field, value] of lv.values) {
      if (field !== "probability") fieldSet.add(field);
      else leadProbability = value;
      if (field === "tag_id") byTeam.get(team)!.push({ [field]: value, count: 1, probability: leadProbability });
      else entry[field] = value;
    }
    byTeam.get(team)!.push(entry);
  }
  const leadsPlsFields = [...fieldSet].sort();

  // _pls_prepare_frequencies (:2655-2696)
  const stages = await env.model("crm.stage").search(TRUE, { order: "sequence, id" });
  const stageRows = stages.length ? await env.model("crm.stage").read(stages, ["sequence"], "") : [];
  const sequence = new Map(stageRows.map((s) => [Number(s["id"]), num(s["sequence"])]));
  const newByTeam = new Map<number, Frequencies>();
  for (const team of teamIds) {
    let fields = [...leadsPlsFields];
    const freq: Frequencies = new Map(fields.map((f) => [f, new Map<string, Count>()]));
    for (const values of byTeam.get(team)!) {
      const won = targetState === "won" ? Number(values["count"]) : 0;
      const lost = targetState === "lost" ? Number(values["count"]) : 0;
      if ("tag_id" in values) { incrementFrequency(freq, "tag_id", values["tag_id"] as PlsValue, won, lost); continue; }
      fields = fields.filter((f) => f !== "tag_id");
      for (const field of fields) {
        if (!(field in values)) continue;
        const value = values[field] as PlsValue;
        if (value || field === "email_state" || field === "phone_state") {
          if (field === "stage_id") {
            const toIncrement = won ? stages : stages.filter((s) => (sequence.get(s) ?? 0) <= (sequence.get(Number(value)) ?? 0));
            for (const s of toIncrement) incrementFrequency(freq, field, s, won, lost);
          } else {
            incrementFrequency(freq, field, value, won, lost);
          }
        }
      }
    }
    newByTeam.set(team, freq);
  }

  // existing frequencies (:2552-2563): search_read as the user
  const teamsOfLeads = teamOrder;
  const freqModel = env.model("crm.lead.scoring.frequency");
  const existingIds = await freqModel.search(and([cond("variable", "in", leadsPlsFields),
    or([cond("team_id", "in", teamsOfLeads), cond("team_id", "=", false)])]));
  const existingRows = existingIds.length ? await freqModel.read(existingIds, ["variable", "value", "won_count", "lost_count", "team_id"], "") : [];
  const existing = new Map<number, Map<string, Map<string, { id: number; won: number; lost: number }>>>();
  for (const f of existingRows) {
    const team = typeof f["team_id"] === "number" ? f["team_id"] : 0;
    if (!existing.has(team)) existing.set(team, new Map(leadsPlsFields.map((x) => [x, new Map()])));
    existing.get(team)!.get(String(f["variable"]))?.set(String(f["value"]), {
      id: Number(f["id"]), won: num(f["won_count"]), lost: num(f["lost_count"]),
    });
  }

  // _pls_update_frequency_table (:2567-2612)
  const step = toState ? 1 : -1;
  const toUpdate = new Map<number, { won_count: number; lost_count: number }>();
  const toCreate: Record<string, unknown>[] = [];
  for (const [team, freq] of newByTeam) {
    const current = existing.get(team);
    for (const [field, params] of freq) {
      for (const [param, res] of params) {
        const cur = current?.get(field)?.get(param);
        if (cur !== undefined) {
          const newWon = cur.won + res.won * step;
          const newLost = cur.lost + res.lost * step;
          toUpdate.set(cur.id, { won_count: newWon > 0 ? newWon : 0.1, lost_count: newLost > 0 ? newLost : 0.1 });
          continue;
        }
        toCreate.push({ variable: field, value: param, won_count: res.won + 0.1, lost_count: res.lost + 0.1, team_id: team || false });
      }
    }
  }
  const sudo = env.sudo();
  for (const [id, vals] of toUpdate) await write(sudo, "crm.lead.scoring.frequency", [id], vals);
  if (toCreate.length) await create(sudo, "crm.lead.scoring.frequency", toCreate);
}

/** `_handle_won_lost(old_status_by_lead, new_status_by_lead)` (:905-952), for the leads `ids` in order. */
export async function handleWonLost(env: Environment, ids: readonly number[],
  oldStatus: ReadonlyMap<number, WonLostStatus>, newStatus: ReadonlyMap<number, WonLostStatus>): Promise<void> {
  const none: WonLostStatus = { is_lost: false, is_won: false };
  const reachWon: number[] = [], leaveWon: number[] = [], reachLost: number[] = [], leaveLost: number[] = [];
  for (const id of ids) {
    const n = newStatus.get(id) ?? none;
    const o = oldStatus.get(id) ?? none;
    if (n.is_lost && n.is_won) {
      if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated won/lost error (${env.lang})`);
      // `%s` of a recordset is its repr, e.g. "crm.lead(24,)"
      throw new ValidationError(`The lead crm.lead(${id},) cannot be won and lost at the same time.`);
    }
    if (n.is_lost && !o.is_lost) reachLost.push(id);
    else if (!n.is_lost && o.is_lost) leaveLost.push(id);
    if (n.is_won && !o.is_won) reachWon.push(id);
    else if (!n.is_won && o.is_won) leaveWon.push(id);
  }
  await incrementFrequencies(env, reachWon, null, "won");
  await incrementFrequencies(env, leaveWon, "won", null);
  await incrementFrequencies(env, reachLost, null, "lost");
  await incrementFrequencies(env, leaveLost, "lost", null);
}

// ------------------------------------------------------------------------------------------------ buttons

function recordIdsOf(ids: number[] | null, what: string): number[] {
  if (ids === null) throw new NotPorted(`${what} without records`);
  return ids;
}

async function activeOf(env: Environment, ids: readonly number[]): Promise<Map<number, boolean>> {
  const rows = (await env.cr.query<{ id: number; active: boolean | null }>("SELECT id, active FROM crm_lead WHERE id = ANY($1::int[])", [ids])).rows;
  return new Map(rows.map((r) => [r.id, r.active === true]));
}

/** crm_lead.py:1031 `action_unarchive`: unarchive, clear the lost reason and recompute the probabilities. */
export async function actionUnarchive(env: Environment, ids: readonly number[]): Promise<void> {
  const active = await activeOf(env, ids);
  const activated = ids.filter((id) => active.get(id) === false);
  // models.py:5284: inactive_recs[active] = True
  if (activated.length) await write(env, MODEL, activated, { active: true });
  if (activated.length) {
    await write(env, MODEL, activated, { lost_reason_id: false });
    await computeProbabilitiesNow(env, activated);
  }
}

/** `records._compute_probabilities()` called directly (:508-516): the assignments of the compute are written
 *  (Field.__set__ on stored fields). */
async function computeProbabilitiesNow(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const rec = new DbRec(env, env.reg.model(MODEL), id);
    const p = await leadProbability(env, rec);
    if (p === undefined) continue;
    const prob = num(await rec.get("probability"));
    const auto = num(await rec.get("automated_probability"));
    const wasAutomated = (await rec.get("active")) === true && floatEqual2(prob, auto);
    await write(env, MODEL, [id], wasAutomated ? { automated_probability: p, probability: p } : { automated_probability: p });
  }
}

/** models.py:5273 action_archive (crm.lead has no override). */
async function actionArchive(env: Environment, ids: readonly number[]): Promise<void> {
  const active = await activeOf(env, ids);
  const todo = ids.filter((id) => active.get(id) === true);
  if (todo.length) await write(env, MODEL, todo, { active: false });
}

/** crm_lead.py:1051 `action_set_lost(**additional_values)`. */
export async function actionSetLost(env: Environment, ids: readonly number[], additional: Record<string, unknown> = {}): Promise<null> {
  await actionArchive(env, ids);
  await write(env, MODEL, ids, { ...additional, probability: 0, automated_probability: 0 });
  return null;
}

/** `_stage_find(domain, limit=None)` (:1001-1026) for the given leads. */
async function stageFind(env: Environment, ids: readonly number[], domain: Domain): Promise<number[]> {
  const teams = new Set<number>();
  for (const r of (await env.cr.query<{ team_id: number | null }>("SELECT team_id FROM crm_lead WHERE id = ANY($1::int[])", [ids])).rows) {
    if (r.team_id) teams.add(r.team_id);
  }
  const base = teams.size ? or([cond("team_ids", "=", false), cond("team_ids", "in", [...teams])]) : cond("team_ids", "=", false);
  return env.model("crm.stage").search(and([base, domain]), { order: "sequence, id" });
}

/** crm_lead.py:1057 `action_set_won`. */
export async function actionSetWon(env: Environment, ids: readonly number[]): Promise<boolean> {
  await actionUnarchive(env, ids);
  const seqOf = async (stageIds: readonly number[]): Promise<Map<number, number>> => new Map((stageIds.length
    ? await env.model("crm.stage").read([...stageIds], ["sequence"], "") : []).map((s) => [Number(s["id"]), num(s["sequence"])]));
  const byStage = new Map<number, number[]>();
  for (const id of ids) {
    const wonStages = await stageFind(env, [id], cond("is_won", "=", true));
    const leadStage = (await env.cr.query<{ stage_id: number | null }>("SELECT stage_id FROM crm_lead WHERE id = $1", [id])).rows[0]?.stage_id ?? null;
    const seqs = await seqOf([...wonStages, ...(leadStage ? [leadStage] : [])]);
    const leadSeq = leadStage ? (seqs.get(leadStage) ?? 0) : 0;
    let stage = wonStages.find((s) => (seqs.get(s) ?? 0) > leadSeq);
    if (stage === undefined) stage = [...wonStages].reverse().find((s) => (seqs.get(s) ?? 0) <= leadSeq);
    if (stage === undefined) {
      // `next(..., won_stages)`: the whole recordset as default; a write of stage_id with it needs a single stage
      if (wonStages.length !== 1) throw new NotPorted("action_set_won without a single won stage");
      stage = wonStages[0]!;
    }
    byStage.set(stage, [...(byStage.get(stage) ?? []), id]);
  }
  for (const [stage, leads] of byStage) await write(env, MODEL, leads, { stage_id: stage, probability: 100 });
  return true;
}

/** `_get_rainbowman_message` (:1111-1200) for one lead. */
async function rainbowmanMessage(env: Environment, id: number): Promise<string | false> {
  const lead = (await env.cr.query<{
    user_id: number | null; team_id: number | null; source_id: number | null; country_id: number | null;
    expected_revenue: string | number | null; day_close: string | number | null; date_closed: string | null; create_date: string | null;
    duration_tracking: Record<string, unknown> | null;
  }>(`SELECT user_id, team_id, source_id, country_id, expected_revenue, day_close, date_closed::text AS date_closed,
      create_date::text AS create_date, duration_tracking FROM crm_lead WHERE id = $1`, [id])).rows[0];
  if (lead === undefined || !lead.user_id) return false;
  const nMessages = Number((await env.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM mail_message WHERE model = $1 AND res_id = $2", [MODEL, id])).rows[0]?.n ?? 0);
  if (nMessages >= 25) return translate(env, "Phew, that took some effort — but you nailed it. Good job!");
  // tz_midnight (:1124-1125): today's midnight in the user's tz (env.user.tz or lead.user_id.tz or UTC), as naive UTC
  const tz = validTz((await userInfo(env)).tz) ?? validTz((await env.cr.query<{ tz: string | null }>(
    "SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [lead.user_id])).rows[0]?.tz) ?? "UTC";
  const now = await dbNow(env);
  const midnight = (await env.cr.query<{ m: string }>(
    `SELECT ((date_trunc('day', $1::timestamptz AT TIME ZONE $2) AT TIME ZONE $2) AT TIME ZONE 'UTC')::text AS m`, [now.toISOString(), tz])).rows[0]!.m;
  const teamCond = lead.team_id ? "team_id = $6" : "team_id IS NULL";
  const sourceCase = lead.source_id ? `source_id = $7 AND ${teamCond}` : "FALSE";
  const countryCase = lead.country_id ? `country_id = $8 AND ${teamCond}` : "FALSE";
  const q = (await env.cr.query<Record<string, string | number | null>>(`SELECT
    MAX(CASE WHEN team_id = $2 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '31 days' AND id <> $4 THEN expected_revenue ELSE 0 END) AS max_team_31,
    MAX(CASE WHEN team_id = $2 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '7 days' AND id <> $4 THEN expected_revenue ELSE 0 END) AS max_team_7,
    MAX(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '31 days' AND id <> $4 THEN expected_revenue ELSE 0 END) AS max_user_31,
    MAX(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '7 days' AND id <> $4 THEN expected_revenue ELSE 0 END) AS max_user_7,
    MIN(CASE WHEN COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '31 days' THEN day_close ELSE 31 END) AS min_day_close_31,
    COUNT(CASE WHEN user_id = $1 THEN 1 ELSE NULL END) AS count_user_closed_year,
    COUNT(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '3 days' AND COALESCE(date_closed, create_date) < $3::timestamp - INTERVAL '2 days' THEN 1 ELSE NULL END) AS count_user_closed_minus3day,
    COUNT(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '2 days' AND COALESCE(date_closed, create_date) < $3::timestamp - INTERVAL '1 days' THEN 1 ELSE NULL END) AS count_user_closed_minus2day,
    COUNT(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp - INTERVAL '1 days' AND COALESCE(date_closed, create_date) < $3::timestamp THEN 1 ELSE NULL END) AS count_user_closed_yesterday,
    COUNT(CASE WHEN user_id = $1 AND COALESCE(date_closed, create_date) >= $3::timestamp THEN 1 ELSE NULL END) AS count_user_closed_today,
    COUNT(CASE WHEN ${sourceCase} THEN 1 ELSE NULL END) AS count_source_closed_year,
    COUNT(CASE WHEN ${countryCase} THEN 1 ELSE NULL END) AS count_country_closed_year
    FROM crm_lead WHERE type = 'opportunity' AND active = True AND probability = 100
      AND DATE_TRUNC('year', COALESCE(date_closed, create_date)) = DATE_TRUNC('year', $3::timestamp)
      AND (user_id = $1 OR team_id = $2) AND $5::int IS NOT NULL AND ($6::int IS NULL OR TRUE) AND ($7::int IS NULL OR TRUE) AND ($8::int IS NULL OR TRUE)`,
    [env.uid, lead.team_id ?? -1, midnight, id, 0, lead.team_id, lead.source_id, lead.country_id])).rows[0]!;
  const n = (k: string): number | null => (q[k] === null || q[k] === undefined ? null : Number(q[k]));
  const revenue = Number(lead.expected_revenue ?? 0);
  const lower = (v: number | null): boolean => !!revenue && v !== null && v < revenue;
  if (n("count_user_closed_year") === 1) return translate(env, "Go, go, go! Congrats for your first deal.");
  if (lower(n("max_team_31"))) return translate(env, "Boom! Team record for the past 30 days.");
  if (lower(n("max_team_7"))) return translate(env, "Yeah! Best deal out of the last 7 days for the team.");
  if (lower(n("max_user_31"))) return translate(env, "You just beat your personal record for the past 30 days.");
  if (lower(n("max_user_7"))) return translate(env, "You just beat your personal record for the past 7 days.");
  if (n("count_user_closed_today") === 5) return translate(env, "You're on fire! Fifth deal won today 🔥");
  if (n("count_user_closed_today") === 1 && n("count_user_closed_yesterday") && n("count_user_closed_minus2day") && !n("count_user_closed_minus3day")) {
    return translate(env, "You're on a winning streak. 3 deals in 3 days, congrats!");
  }
  const dayClose = Number(lead.day_close ?? 0);
  const closedAfterCreate = lead.date_closed && lead.create_date
    ? (Date.parse(`${lead.date_closed.replace(" ", "T")}Z`) - Date.parse(`${lead.create_date.replace(" ", "T")}Z`)) / 1000 > 60 : false;
  if (n("min_day_close_31") === dayClose && dayClose < 31 && closedAfterCreate) {
    return translate(env, "Wow, that was fast. That deal didn’t stand a chance!");
  }
  const tracking = lead.duration_tracking ?? {};
  const stageIds = Object.entries(tracking).filter(([k, d]) => /^\d+$/.test(k) && typeof d === "number" && d >= 60).map(([k]) => Number(k));
  if (stageIds.length === 1) {
    const teamDomain = or([cond("team_ids", "in", false), cond("team_ids", "in", lead.team_id ? [lead.team_id] : [])]);
    const first = (await env.model("crm.stage").search(teamDomain, { order: "sequence ASC", limit: 1 }))[0];
    if (first !== undefined && first === stageIds[0]) {
      const name = (await env.model("crm.stage").read([first], ["name"], ""))[0]?.["name"];
      return translate(env, "No detours, no delays - from %(stage_name)s straight to the win! 🚀").replace("%(stage_name)s", String(name ?? ""));
    }
  }
  if (n("count_country_closed_year") === 1 && lead.country_id) {
    const name = (await env.model("res.country").read([lead.country_id], ["name"], ""))[0]?.["name"];
    return translate(env, "You just expanded the map! First win in %(country)s.").replace("%(country)s", String(name ?? ""));
  }
  if (n("count_source_closed_year") === 1 && lead.source_id) {
    const name = (await env.model("utm.source").read([lead.source_id], ["name"], ""))[0]?.["name"];
    return translate(env, "Yay, your first win from %(utm_source_name)s!").replace("%(utm_source_name)s", String(name ?? ""));
  }
  return false;
}

// the buttons run their writes in one tracking scope: Odoo logs one tracking message per lead at precommit
registerMethod(MODEL, "action_unarchive", async (env, ids) => withLeadTracking(env, async () => {
  await actionUnarchive(env, recordIdsOf(ids, "action_unarchive"));
  return null;
}), { apiModel: false });

registerMethod(MODEL, "action_restore", async (env, ids) => withLeadTracking(env, async () => {
  const leads = recordIdsOf(ids, "action_restore");
  await actionUnarchive(env, leads);
  // :1047-1048: lead.probability = lead.automated_probability
  for (const id of leads) {
    const auto = (await env.cr.query<{ a: number | null }>("SELECT automated_probability AS a FROM crm_lead WHERE id = $1", [id])).rows[0]?.a ?? 0;
    await write(env, MODEL, [id], { probability: auto });
  }
  return null;
}), { apiModel: false });

// :1083-1087 action_set_automated_probability: ensure_one, _compute_probabilities, probability := automated_probability
registerMethod(MODEL, "action_set_automated_probability", async (env, ids) => withLeadTracking(env, async () => {
  const leads = recordIdsOf(ids, "action_set_automated_probability");
  // models.py ensure_one: ValueError("Expected singleton: crm.lead(...)") is not ported
  if (leads.length !== 1) throw new NotPorted(`ensure_one on crm.lead(${leads.join(", ")}) in action_set_automated_probability`);
  await computeProbabilitiesNow(env, leads);
  const auto = (await env.cr.query<{ a: number | null }>("SELECT automated_probability AS a FROM crm_lead WHERE id = $1", [leads[0]])).rows[0]?.a ?? 0;
  await write(env, MODEL, leads, { probability: auto });
  return null;
}), { apiModel: false });

registerMethod(MODEL, "action_set_lost", async (env, ids, _args, kwargs) => {
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kwargs)) extra[k] = v;
  return withLeadTracking(env, () => actionSetLost(env, recordIdsOf(ids, "action_set_lost"), extra));
}, { apiModel: false });

registerMethod(MODEL, "action_set_won", async (env, ids) => withLeadTracking(env, () => actionSetWon(env, recordIdsOf(ids, "action_set_won"))), { apiModel: false });

registerMethod(MODEL, "action_set_won_rainbowman", async (env, ids) => {
  const leads = recordIdsOf(ids, "action_set_won_rainbowman");
  if (leads.length !== 1) throw new NotPorted("action_set_won_rainbowman on several records (ensure_one)");
  await withLeadTracking(env, () => actionSetWon(env, leads));
  const message = await rainbowmanMessage(env, leads[0]!);
  if (!message) return true;
  // :1095-1101: the team leader's image, or the smiley
  const teamUser = (await env.cr.query<{ user_id: number | null }>(
    "SELECT t.user_id FROM crm_lead l LEFT JOIN crm_team t ON t.id = l.team_id WHERE l.id = $1", [leads[0]!])).rows[0]?.user_id ?? null;
  let hasImage = false;
  if (teamUser !== null) {
    const users = env.reg.model("res.users");
    hasImage = !!(await new ModelImpl(env, users).values([teamUser], users.fields.get("image_1024")!)).get(teamUser);
  }
  return {
    effect: {
      fadeout: "slow",
      message,
      img_url: hasImage ? `/web/image/res.users/${teamUser}/image_1024` : "/web/static/img/smile.svg",
      type: "rainbow_man",
    },
  };
}, { apiModel: false });

registerMethod(MODEL, "get_rainbowman_message", async (env, ids) => {
  const leads = recordIdsOf(ids, "get_rainbowman_message");
  if (leads.length !== 1) throw new NotPorted("get_rainbowman_message on several records (ensure_one)");
  const id = leads[0]!;
  const won = (await env.cr.query<{ w: boolean | null }>(
    "SELECT s.is_won AS w FROM crm_lead l LEFT JOIN crm_stage s ON s.id = l.stage_id WHERE l.id = $1", [id])).rows[0]?.w === true;
  return won ? rainbowmanMessage(env, id) : false;
}, { apiModel: false });

/**
 * crm_lead.py:2377-2474 `_cron_update_automated_probabilities`:
 *  1) `_rebuild_pls_frequency_table` (:2387-2400): truncate `crm_lead_scoring_frequency` and rebuild from all
 *     closed (won/lost) leads created on or after `crm.pls_start_date`;
 *  2) `_update_automated_probabilities` (:2402-2473): recompute naive Bayes probabilities for all active pending
 *     leads with a stage created on or after `crm.pls_start_date` and SQL-update `automated_probability` (and
 *     `probability` when aligned or null).
 */
export async function cronUpdateAutomatedProbabilities(env: Environment): Promise<void> {
  // Clear cached config parameters so updates just written by crm.lead.pls.update are visible.
  env.cache.delete("crm.pls.icp:crm.pls_fields");
  env.cache.delete("crm.pls.icp:crm.pls_start_date");

  // 1. _rebuild_pls_frequency_table (:2387-2400)
  if (!env.su) {
    try {
      await checkModelAccess(env, env.reg.model(MODEL), "unlink");
    } catch (e) {
      if (e instanceof AccessError) throw new UserError(translate(env, "You don't have the access needed to run this cron.", "crm"));
      throw e;
    }
  }
  await env.cr.query("TRUNCATE TABLE crm_lead_scoring_frequency");

  const start = await safeStartDate(env);
  if (start) {
    const teamIds = [...(await env.model("crm.team").search(TRUE, { activeTest: false })), 0];
    const closedIds = await env.sudo().model(MODEL).search(
      and([cond("create_date", ">=", start), cond("won_status", "in", ["lost", "won"])]),
      { activeTest: false },
    );
    const leadValues = closedIds.length ? await sqlPlsValues(env, closedIds) : new Map<number, LeadValues>();
    const byTeam = new Map<number, Record<string, PlsValue | number>[]>(teamIds.map((t) => [t, []]));
    const fieldSet = new Set<string>();
    for (const lv of leadValues.values()) {
      const team = lv.team_id || 0;
      if (!byTeam.has(team)) byTeam.set(team, []);
      const entry: Record<string, PlsValue | number> = { count: 1 };
      let leadProbability: PlsValue = 0;
      for (const [field, value] of lv.values) {
        if (field !== "probability") fieldSet.add(field);
        else leadProbability = value;
        if (field === "tag_id") byTeam.get(team)!.push({ [field]: value, count: 1, probability: leadProbability });
        else entry[field] = value;
      }
      byTeam.get(team)!.push(entry);
    }
    const leadsPlsFields = [...fieldSet].sort();
    const stages = await env.model("crm.stage").search(TRUE, { order: "sequence, id" });
    const stageRows = stages.length ? await env.model("crm.stage").read(stages, ["sequence"], "") : [];
    const sequence = new Map(stageRows.map((s) => [Number(s["id"]), num(s["sequence"])]));
    const toCreate: Record<string, unknown>[] = [];
    for (const team of teamIds) {
      let fields = [...leadsPlsFields];
      const freq: Frequencies = new Map(fields.map((f) => [f, new Map<string, Count>()]));
      for (const values of byTeam.get(team) ?? []) {
        const won = Number(values["probability"] ?? 0) === 100 ? Number(values["count"]) : 0;
        const lost = Number(values["probability"] ?? 1) === 0 ? Number(values["count"]) : 0;
        if ("tag_id" in values) { incrementFrequency(freq, "tag_id", values["tag_id"] as PlsValue, won, lost); continue; }
        fields = fields.filter((f) => f !== "tag_id");
        for (const field of fields) {
          if (!(field in values)) continue;
          const value = values[field] as PlsValue;
          if (value || field === "email_state" || field === "phone_state") {
            if (field === "stage_id") {
              const toIncrement = won ? stages : stages.filter((s) => (sequence.get(s) ?? 0) <= (sequence.get(Number(value)) ?? 0));
              for (const s of toIncrement) incrementFrequency(freq, field, s, won, lost);
            } else {
              incrementFrequency(freq, field, value, won, lost);
            }
          }
        }
      }
      for (const [field, params] of freq) {
        for (const [param, res] of params) {
          toCreate.push({
            variable: field, value: param,
            won_count: res.won + 0.1, lost_count: res.lost + 0.1,
            team_id: team || false,
          });
        }
      }
    }
    if (toCreate.length) await create(env.sudo(), "crm.lead.scoring.frequency", toCreate);
  }

  // 2. _update_automated_probabilities (:2402-2473)
  if (!start) return;
  const pendingIds = await env.model(MODEL).search(and([
    cond("stage_id", "!=", false),
    cond("create_date", ">=", start),
    cond("won_status", "=", "pending"),
  ]));
  if (!pendingIds.length) return;
  const pendingValues = await sqlPlsValues(env, pendingIds);
  const orderedIds = [...pendingValues.keys()];
  const orderedList = orderedIds.map((id) => pendingValues.get(id)!);
  const probs = await naiveBayes(env, orderedList);
  const byProb = new Map<number, number[]>();
  for (let i = 0; i < orderedIds.length; i++) {
    const p = probs.get(i);
    if (p === undefined) continue;
    const list = byProb.get(p) ?? [];
    list.push(orderedIds[i]!);
    byProb.set(p, list);
  }
  for (const [prob, ids] of byProb) {
    await env.cr.query(
      `UPDATE crm_lead
          SET automated_probability = $1,
              probability = CASE WHEN (probability = automated_probability OR probability IS NULL) THEN $1 ELSE probability END
        WHERE id = ANY($2::int[])`,
      [prob, ids],
    );
  }
}

setHandleWonLost(handleWonLost);
