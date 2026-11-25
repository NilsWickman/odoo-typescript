/**
 * The cron runner (odoo/odoo/addons/base/models/ir_cron.py) for the Worker's `scheduled()` handler:
 * `_process_jobs` (:189-215: version and module checks, the ready jobs by failure_count, priority, id),
 * `_process_jobs_loop` (:218-240: one job at a time, locked with `_acquire_one_job` :311-389, FOR NO KEY UPDATE
 * SKIP LOCKED, committed and released after it), `_process_job` (:402-458), `_run_job` (:461-571, the progress record,
 * the server action, the completion status), `_update_failure_count` (:574-644), `_clear_schedule`,
 * `_reschedule_later` and `_reschedule_asap` (:646-690).
 *
 * Only jobs whose server action is ported run: the hand-ported jobs (`CRON_JOBS`, by model and code), else a server
 * action of state `code` that one of the code runners takes (`codeJob`: the hand port's interpreter, or the compiled
 * build's safe_eval, compiler/runtime/safe_eval.ts, which reaches the build's compiled methods). A job that is not
 * ported is left as it is, unlocked, untouched: its acquisition is rolled back. The runner only serves databases named in the CRON_DBS
 * binding, so measured runs stay inert as the oracle's (max_cron_threads = 0).
 */
import { Cursor } from "../db";
import type { Env } from "../env";
import * as D from "../orm/domain";
import { createEnvironment } from "../orm/env";
import { create } from "../orm/create";
import type { Domain, Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { registerRecordCompute } from "../orm/recompute";
import { NotPorted, OdooError, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { bindRequestCursor, requestOfCursor } from "../http/context";
import { checkModelAccess } from "../orm/access";
import { hasGroup } from "../orm/env";
import { contextToday } from "./account_computes";
import { postMoves } from "./account_buttons";
import { langOf, translate, translatedSql } from "./util";
import { endExpiredPolls } from "../mail/poll";
import { runServerAction } from "./ir_actions_server";
import { codeRunnerFor } from "./server_action_code";
import { processEmailQueue } from "../mail/mail_queue";

/**
 * ir_cron.py:872-916 `_commit_progress(processed, remaining=, deactivate=)`: the progress record of the run (context
 * `ir_cron_progress_id`) gets done += processed, the remaining count and the deactivation, then the job's transaction
 * is committed. Returns the seconds left to the run (context `cron_end_time`, on the clock `runJob` set it with), or
 * Infinity outside a cron run, as :896-916.
 */
export async function commitProgress(env: Environment, processed: number, remaining?: number, deactivate = false): Promise<number> {
  const pid = env.context["ir_cron_progress_id"];
  const inRun = typeof pid === "number";
  if (inRun) {
    const row = (await env.cr.query<{ done: number; remaining: number }>("SELECT done, remaining FROM ir_cron_progress WHERE id = $1", [pid])).rows[0];
    if (row === undefined) throw new NotPorted("cron progress record missing");
    await write(env.sudo(), "ir.cron.progress", [pid], {
      remaining: remaining ?? Math.max(row.remaining - processed, 0), done: row.done + processed, ...(deactivate ? { deactivate: true } : {}),
    });
  }
  await env.cr.commitAndContinue();
  for (const cb of env.cr.postcommit.splice(0)) await cb(); // sql_db.py commit: `cr.postcommit.run()`
  if (!inRun) return Infinity;
  const end = env.context["cron_end_time"];
  return typeof end === "number" ? Math.max(end - Date.now() / 1000, 0) : Infinity;
}

/** `fields.Datetime.now()` (the domain value "now", domains.py) on the database clock, to the second. */
async function utcNow(env: Environment): Promise<string> {
  return (await env.cr.query<{ t: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS t")).rows[0]!.t;
}

/** A job whose action is ported only while it has nothing to do: what it would act on refuses. */
function nothingDue(model: string, domain: (env: Environment) => Promise<Domain>, what: string): JobFn {
  return async (env) => {
    if ((await env.model(model).search(await domain(env), { limit: 1 })).length) throw new NotPorted(what);
  };
}

const BASE_VERSION = "20.0.1.3"; // odoo/odoo/addons/base/__manifest__.py of dd5d3718, as `ir_module_module.latest_version`
const MIN_RUNS_PER_JOB = 10;
const MIN_TIME_PER_JOB = 120; // seconds
const CONSECUTIVE_TIMEOUT_FOR_FAILURE = 3;
const MIN_FAILURE_COUNT_BEFORE_DEACTIVATION = 5;
const MIN_DELTA_BEFORE_DEACTIVATION_DAYS = 7;
const GC_UNLINK_LIMIT = 100_000; // tools/constants.py:19

type Status = "fully done" | "partially done" | "failed";
interface Progress { id: number; done: number; remaining: number; deactivate: boolean }
/** A job's server action: its environment and the Worker's bindings, for the bus fan-out after its commit
 * (`cr.postcommit`, run by `runJob` once the job's transaction committed). */
export type JobFn = (env: Environment, worker: Env) => Promise<void>;

/** The ported server actions of cron jobs, by `model|code`. */
const CRON_JOBS = new Map<string, JobFn>([
  // account_move.py:7181-7215 `_autopost_draft_entries`: draft moves with auto_post up to today are posted in one
  // `_post()` (soft), with the progress committed before and after; a move that cannot be posted (UserError, then one
  // by one with a message on the move and auto_post reset) refuses
  ["account.move|model._autopost_draft_entries()", async (env) => {
    const batch = 100;
    const domain = D.and([D.cond("state", "=", "draft"), D.cond("date", "<=", await contextToday(env)), D.cond("auto_post", "!=", "no")]);
    const moves = await env.model("account.move").search(domain, { limit: batch });
    const remaining = moves.length < batch ? moves.length : await env.model("account.move").searchCount(domain);
    await commitProgress(env, 0, remaining);
    try {
      await postMoves(env, moves, true);
    } catch (e) {
      if (e instanceof UserError) throw new NotPorted(`autopost of a move that cannot be posted (${e.message})`);
      throw e;
    }
    await commitProgress(env, moves.length);
  }],
  // mail_poll.py:61-65 `_end_expired_polls` (src/mail/poll.ts)
  ["mail.poll|model._end_expired_polls()", endExpiredPolls],
  // mail_mail.py:229-284 `process_email_queue` (src/mail/mail_queue.ts): D9, every connection refused
  ["mail.mail|model.process_email_queue(batch_size=1000)", (env, worker) => processEmailQueue(env, worker, 1000)],
  // discuss_channel_member.py:422-427 `_cleanup_expired_mutes`: the write syncs the members' stores over the bus
  ["discuss.channel.member|model._cleanup_expired_mutes()", nothingDue("discuss.channel.member",
    async (env) => D.cond("mute_until_dt", "<=", await utcNow(env)),
    "unmuting channel members (store sync of the write)")],
  // mail_scheduled_message.py:275-285 `_post_messages_cron`: the past-due scheduled messages are posted (not ported)
  ["mail.scheduled.message|model._post_messages_cron()", nothingDue("mail.scheduled.message",
    async (env) => D.cond("scheduled_date", "<=", await utcNow(env)), "posting scheduled messages (_post_message)")],
  // mail_push.py:22-33 `_push_notification_to_endpoint`: the queued web push notifications (not ported)
  ["mail.push|model._push_notification_to_endpoint()", nothingDue("mail.push", async () => D.TRUE, "web push notifications to endpoints")],
  // discuss_channel.py:801-825 `_cron_sync_last_interest_dt`: the job's triggers dropped, then the queued updates
  // drained (not ported: the post-commit sync of each post drains them; rows left by a failed sync refuse)
  ["discuss.channel|model._cron_sync_last_interest_dt()", async (env) => {
    const cron = (await env.cr.query<{ id: number }>(
      `SELECT c.id FROM ir_cron c JOIN ir_model_data d ON d.model = 'ir.cron' AND d.res_id = c.id
        WHERE d.module = 'mail' AND d.name = 'ir_cron_discuss_channel_sync_last_interest_dt'`)).rows[0];
    if (!cron) throw new NotPorted("the last interest sync cron is missing (env.ref ValueError)");
    await env.cr.query("DELETE FROM ir_cron_trigger WHERE cron_id = $1", [cron.id]);
    if ((await env.cr.query("SELECT 1 FROM discuss_channel_last_interest_update LIMIT 1")).rows.length) {
      throw new NotPorted("draining queued last interest updates (_sync_last_interest_dt from the cron)");
    }
  }],
  // resource_calendar.py:160-165 `_calendar_clean_up`: attendances to drop for their calendar's type, and recurrent
  // dated attendances whose exclusions or single occurrence change (not ported): refused when any could be concerned
  ["resource.calendar|model._calendar_clean_up()", async (env) => {
    const concerned = await env.cr.query(
      `SELECT 1 FROM resource_calendar_attendance a JOIN resource_calendar c ON c.id = a.calendar_id
        WHERE c.calendar_type = 'undefined' OR (c.calendar_type = 'fixed' AND a.date IS NOT NULL)
           OR (c.calendar_type = 'variable' AND a.date IS NULL) OR (a.recurrency AND a.date IS NOT NULL) LIMIT 1`);
    if (concerned.rows.length) throw new NotPorted("cleaning up calendar attendances");
  }],
  // res_users_deletion.py:37-55 `_gc_portal_users`: the requests to do; without any, the progress (0, 0) committed
  ["res.users.deletion|model._gc_portal_users(batch_size=50)", async (env) => {
    if ((await env.model("res.users.deletion").search(D.cond("state", "=", "todo"), { limit: 1 })).length) {
      throw new NotPorted("deleting portal users (res.users.deletion)");
    }
    await commitProgress(env, 0, 0);
  }],
  // project_task_type.py:230-239 `_send_rating_all`: the periodic rating stages past their deadline (not ported)
  ["project.task.type|model._send_rating_all()", nothingDue("project.task.type", async (env) => D.and([
    D.cond("rating_active", "=", true), D.cond("rating_status", "=", "periodic"), D.cond("rating_request_deadline", "<=", await utcNow(env)),
  ]), "periodic rating requests (_send_task_rating_mail)")],
  // purchase_order.py:1122-1139 `_send_reminder_mail`: nothing for a user without purchase.group_send_reminder; an
  // order to remind (:1191-1199, the service filter left out: refusing more) whose planned date less its reminder days
  // is today (`datetime.today()`, the database's UTC date here) refuses (message_post_with_source is not ported)
  ["purchase.order|model._send_reminder_mail()", async (env) => {
    if (!(await hasGroup(env, "purchase.group_send_reminder"))) return;
    if ((await env.reg.xmlid(env.cr, "purchase.email_template_edi_purchase_reminder")) === null) return;
    const ids = await env.model("purchase.order").search(D.and([
      D.cond("partner_id", "!=", false), D.cond("state", "=", "purchase"), D.cond("acknowledged", "=", false), D.cond("receipt_reminder_email", "=", true),
    ]));
    if (!ids.length) return;
    const today = await env.cr.query(
      `SELECT 1 FROM purchase_order WHERE id = ANY($1::int[]) AND date_planned IS NOT NULL
          AND (date_planned - make_interval(days => COALESCE(reminder_date_before_receipt, 0)))::date = (now() AT TIME ZONE 'UTC')::date LIMIT 1`, [ids]);
    if (today.rows.length) throw new NotPorted("purchase receipt reminders (message_post_with_source)");
  }],
  // auth_signup res_users.py:266-292 `send_unregistered_user_reminder`: the internal users invited five days ago
  // (`Datetime.today()`, midnight) who never logged in get a reminder to their inviter (not ported)
  ["res.users|model.send_unregistered_user_reminder(batch_size=100)", async (env) => {
    if ((await env.reg.xmlid(env.cr, "auth_signup.mail_template_data_unregistered_users")) === null) {
      throw new NotPorted("unregistered user reminder without its template (deactivates the job)");
    }
    const due = await env.cr.query(
      `SELECT 1 FROM res_users u JOIN res_users c ON c.id = u.create_uid JOIN res_partner cp ON cp.id = c.partner_id
        WHERE u.active AND u.share IS NOT TRUE AND cp.email IS NOT NULL AND cp.email != ''
          AND u.create_date >= date_trunc('day', now() AT TIME ZONE 'UTC') - interval '5 days'
          AND u.create_date < date_trunc('day', now() AT TIME ZONE 'UTC') - interval '4 days'
          AND NOT EXISTS (SELECT 1 FROM res_users_log l WHERE l.create_uid = u.id) LIMIT 1`);
    if (due.rows.length) throw new NotPorted("unregistered user reminders (mail.template send_mail)");
  }],
  // mail_notification.py:92-102 `_gc_notifications`: read email/inbox notifications of internal partners, older than
  // the age, sent or cancelled, are deleted (at most GC_UNLINK_LIMIT); its (done, remaining) is not used by the action
  ["mail.notification|model._gc_notifications(max_age_days=180)", async (env) => {
    const now = (await env.cr.query<{ t: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC') - interval '180 days', 'YYYY-MM-DD HH24:MI:SS') AS t")).rows[0]!.t;
    const ids = await env.model("mail.notification").search(D.and([
      D.cond("is_read", "=", true), D.cond("read_date", "<", now), D.cond("res_partner_id.partner_share", "=", false),
      D.cond("notification_status", "in", ["sent", "canceled"]),
    ]), { limit: GC_UNLINK_LIMIT });
    if (ids.length) await unlink(env, "mail.notification", ids);
  }],
]);

interface Job {
  id: number; cron_name: string; user_id: number; ir_actions_server_id: number; interval_number: number; interval_type: string;
  nextcall: string; lastcall: string | null; failure_count: number; first_failure_date: string | null; active: boolean;
  progress_id: number | null; done: number; remaining: number; timed_out_counter: number;
}

async function environment(cr: Cursor, uid: number, context: Record<string, unknown>): Promise<Environment> {
  return createEnvironment({ cr, uid, context, su: uid === 1 });
}

/** `_get_ready_sql_condition`: active, and its nextcall or a trigger is due (`cr.now()`, the transaction's start). */
const READY = `active IS TRUE AND (nextcall <= (now() AT TIME ZONE 'UTC') OR id IN (SELECT cron_id FROM ir_cron_trigger WHERE call_at <= (now() AT TIME ZONE 'UTC')))`;

const JOB_COLUMNS = `ir_cron.id, ir_cron.cron_name, ir_cron.user_id, ir_cron.ir_actions_server_id, ir_cron.interval_number, ir_cron.interval_type,
  to_char(ir_cron.nextcall, 'YYYY-MM-DD HH24:MI:SS') AS nextcall, to_char(ir_cron.lastcall, 'YYYY-MM-DD HH24:MI:SS') AS lastcall, ir_cron.failure_count,
  to_char(ir_cron.first_failure_date, 'YYYY-MM-DD HH24:MI:SS') AS first_failure_date, ir_cron.active,
  lcp.progress_id, COALESCE(lcp.done, 0) AS done, COALESCE(lcp.remaining, 0) AS remaining, COALESCE(lcp.timed_out_counter, 0) AS timed_out_counter`;

/** The unported due jobs already reported by this isolate (one log line each, not one a minute). */
const WARNED = new Set<string>();

/** A cron job's server action ported elsewhere (src/models/payment_flow.ts), by `model|code`. */
export function registerCronJob(key: string, fn: JobFn): void {
  if (CRON_JOBS.has(key)) throw new Error(`cron job ${key} registered twice`);
  CRON_JOBS.set(key, fn);
}

/**
 * `_callback` (ir_cron.py:692-710) of a job that is not hand-ported: `ir.actions.server.browse(id).run()` (the server
 * action's eval context, access check and code, src/models/ir_actions_server.ts runServerAction), when its state is
 * `code` and a code runner takes the code without running it. Otherwise the refusal.
 */
async function codeJob(env: Environment, action: { id: number; model: string; state: string; code: string | null }): Promise<JobFn | NotPorted> {
  if (action.state !== "code") return new NotPorted(`cron job of a server action of type ${action.state}`);
  const code = action.code ?? "";
  const { runner, refusal } = await codeRunnerFor(env, action.model, code);
  if (runner === null) return refusal ?? new NotPorted(`cron job code ${code.trim()}`);
  return async (jenv) => { await runServerAction(jenv, action.id); };
}

/** `_process_jobs(db_name)` with `_process_jobs_loop`. Returns the ids of the jobs run. */
export async function processJobs(env: Env, db: string): Promise<number[]> {
  const ran: number[] = [];
  const cr = new Cursor(env, db);
  let ready: { id: number; model: string; code: string | null; action: number; state: string }[];
  const byCode = new Map<number, JobFn | NotPorted>();
  try {
    const version = (await cr.query<{ v: string | null }>("SELECT latest_version AS v FROM ir_module_module WHERE name = 'base'")).rows[0]?.v ?? null;
    if (version === null) return ran; // BadModuleState
    if (version !== BASE_VERSION) return ran; // BadVersion
    const changes = Number((await cr.query<{ n: string }>("SELECT count(*)::text AS n FROM ir_module_module WHERE state LIKE 'to %'")).rows[0]?.n ?? 0);
    ready = (await cr.query<{ id: number; model: string; code: string | null; action: number; state: string }>(
      `SELECT c.id, m.model, a.code, a.id AS action, a.state FROM ir_cron c JOIN ir_act_server a ON a.id = c.ir_actions_server_id JOIN ir_model m ON m.id = a.model_id
        WHERE ${READY.replace(/\b(active|nextcall|id)\b/g, "c.$1")} ORDER BY c.failure_count, c.priority, c.id`)).rows;
    if (ready.length && changes) throw new NotPorted("cron jobs while modules are installing (_check_modules_state, reset_modules_state)");
    // the jobs no hand-ported function serves: the code runners read their code (without running it)
    const lookup = await environment(cr, 1, {});
    for (const j of ready) {
      if (!CRON_JOBS.has(`${j.model}|${(j.code ?? "").trim()}`)) byCode.set(j.id, await codeJob(lookup, { id: j.action, model: j.model, state: j.state, code: j.code }));
    }
    await cr.rollback();
  } finally {
    await cr.close();
  }
  for (const job0 of ready) {
    const found = CRON_JOBS.get(`${job0.model}|${(job0.code ?? "").trim()}`) ?? byCode.get(job0.id);
    // not ported: left untouched (still due) rather than run differently from Odoo
    if (!found || found instanceof NotPorted) {
      const key = `${db}|${job0.id}`;
      if (!WARNED.has(key)) { WARNED.add(key); console.warn(`cron: job ${job0.id} (${job0.model}: ${(job0.code ?? "").trim()}) is not ported, left as it is${found ? ` (${found.message})` : ""}`); }
      continue;
    }
    const fn = found;
    // refused once in this isolate: not retried every minute (each try creates and drops a progress record)
    if (WARNED.has(`${db}|${job0.id}|refused`)) continue;
    const cronCr = new Cursor(env, db);
    try {
      let job: Job | undefined;
      try {
        job = (await cronCr.query<Job>(
          `WITH last_cron_progress AS (
             SELECT id AS progress_id, cron_id, timed_out_counter, done, remaining FROM ir_cron_progress WHERE cron_id = $1 ORDER BY id DESC LIMIT 1)
           SELECT ${JOB_COLUMNS} FROM ir_cron LEFT JOIN last_cron_progress lcp ON lcp.cron_id = ir_cron.id
            WHERE ir_cron.id = $1 AND ${READY.replace(/\b(active|nextcall)\b/g, "ir_cron.$1").replace(/\bid IN\b/, "ir_cron.id IN")}
           FOR NO KEY UPDATE SKIP LOCKED`, [job0.id])).rows[0];
      } catch (e) {
        // TransactionRollbackError: processed by another worker meanwhile
        if (typeof e === "object" && e !== null && "code" in e && String((e as { code: unknown }).code).startsWith("40")) { await cronCr.rollback(); continue; }
        throw e;
      }
      if (!job) { await cronCr.rollback(); continue; } // being processed by another worker
      try {
        await processJob(() => new Cursor(env, db), cronCr, job, fn, env);
      } catch (e) {
        // a refused run leaves the job as it was (runJob dropped its progress record); the next jobs still run
        if (!(e instanceof NotPorted)) throw e;
        await cronCr.rollback();
        const key = `${db}|${job.id}|refused`;
        if (!WARNED.has(key)) { WARNED.add(key); console.warn(`cron: job ${job.id} refused: ${e.message}`); }
        continue;
      }
      await cronCr.commit();
      ran.push(job.id);
    } finally {
      await cronCr.close();
    }
  }
  return ran;
}

/** `_process_job`. */
async function processJob(open: () => Cursor, cronCr: Cursor, job: Job, fn: JobFn, worker: Env): Promise<Status> {
  // `_clear_schedule`
  await cronCr.query("DELETE FROM ir_cron_trigger WHERE cron_id = $1 AND call_at <= date_trunc('second', now() AT TIME ZONE 'UTC')", [job.id]);
  const failedByTimeout = job.timed_out_counter >= CONSECUTIVE_TIMEOUT_FOR_FAILURE && !job.done;
  let status: Status;
  if (!failedByTimeout) status = await runJob(open, job, fn, worker);
  else {
    status = "failed";
    await cronCr.query("UPDATE ir_cron_progress SET timed_out_counter = 0 WHERE id = $1", [job.progress_id]);
  }
  await updateFailureCount(cronCr, job, status);
  if (status === "fully done" || status === "failed") await rescheduleLater(cronCr, job);
  else await cronCr.query("INSERT INTO ir_cron_trigger (call_at, cron_id) VALUES (date_trunc('second', now() AT TIME ZONE 'UTC'), $1)", [job.id]);
  return status;
}

/** `_run_job`: the server action with a progress record per run, until done, failed or out of runs and time. */
async function runJob(open: () => Cursor, job: Job, fn: JobFn, worker: Env): Promise<Status> {
  let timedOut = job.timed_out_counter;
  const start = Date.now() / 1000;
  let status: Status | null = null;
  let loops = 0;
  while (status === null && (loops < MIN_RUNS_PER_JOB || Date.now() / 1000 < start + MIN_TIME_PER_JOB)) {
    // `_add_progress` then job_cr.commit()
    const pcr = open();
    let progress: Progress = { id: 0, done: 0, remaining: 0, deactivate: false };
    try {
      const penv = await environment(pcr, job.user_id, { lastcall: job.lastcall, cron_id: job.id });
      const [pid] = await create(penv.sudo(), "ir.cron.progress", [{ cron_id: job.id, remaining: 0, done: 0, timed_out_counter: timedOut + 1 }]);
      await pcr.commit();
      progress = { id: pid!, done: 0, remaining: 0, deactivate: false };
    } finally {
      await pcr.close();
    }
    // `_callback`: the server action, flushed and committed (rolled back on error)
    const jcr = open();
    let success = false;
    let postcommit: (() => Promise<void>)[] = [];
    try {
      // :485-489 the job's context, `cron_end_time` on this loop's clock (`time.monotonic()` there)
      const jenv = await environment(jcr, job.user_id, { lastcall: job.lastcall, cron_id: job.id, cron_end_time: start + MIN_TIME_PER_JOB, ir_cron_progress_id: progress.id });
      await fn(jenv, worker);
      await jcr.commit();
      success = true;
      postcommit = jcr.postcommit.splice(0);
    } catch (e) {
      await jcr.rollback();
      if (e instanceof NotPorted) {
        // a partly ported action is not an Odoo failure: its progress record goes, the job stays as it was
        const ccr = open();
        try { await ccr.query("DELETE FROM ir_cron_progress WHERE id = $1", [progress.id]); await ccr.commit(); } finally { await ccr.close(); }
        throw e;
      }
      console.warn(`Job ${JSON.stringify(job.cron_name)} (${job.id}) server action #${job.ir_actions_server_id} failed`, e);
    } finally {
      await jcr.close();
    }
    // sql_db.py commit: `cr.postcommit.run()` (the job's bus rows dispatched once visible), in addition order
    for (const cb of postcommit) await cb();
    // :545-549 `progress.timed_out_counter = 0` then job_cr.commit()
    const ucr = open();
    try {
      const uenv = await environment(ucr, job.user_id, { lastcall: job.lastcall, cron_id: job.id });
      const [row] = (await ucr.query<{ t: number | null; done: number | null; remaining: number | null; deactivate: boolean | null }>(
        "SELECT timed_out_counter AS t, done, remaining, deactivate FROM ir_cron_progress WHERE id = $1", [progress.id])).rows;
      progress = { id: progress.id, done: row?.done ?? 0, remaining: row?.remaining ?? 0, deactivate: Boolean(row?.deactivate) };
      if (row && row.t !== 0) await write(uenv.sudo(), "ir.cron.progress", [progress.id], { timed_out_counter: 0 });
      await ucr.commit();
    } finally {
      await ucr.close();
    }
    const { done, remaining } = progress;
    if (!success && done && remaining) { /* some progress committed: hopefully temporary */ }
    else if (!success) status = "failed";
    else if (remaining === 0) { status = "fully done"; if (progress.deactivate) job.active = false; }
    else if (done === 0) status = "partially done";
    loops++;
    timedOut = 0;
  }
  return status ?? "partially done";
}

/** `_update_failure_count`. */
async function updateFailureCount(cr: Cursor, job: Job, status: Status): Promise<void> {
  let failureCount = 0, firstFailure: string | null = null, active = job.active;
  if (status === "failed") {
    const now = (await cr.query<{ t: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS t")).rows[0]!.t;
    failureCount = job.failure_count + 1;
    firstFailure = job.first_failure_date ?? now;
    const elapsed = (Date.parse(`${now}Z`) - Date.parse(`${firstFailure.replace(" ", "T")}Z`)) / 86400000;
    if (failureCount >= MIN_FAILURE_COUNT_BEFORE_DEACTIVATION && elapsed > MIN_DELTA_BEFORE_DEACTIVATION_DAYS) {
      failureCount = 0; firstFailure = null; active = false;
      console.warn(`Cron job ${JSON.stringify(job.cron_name)} (${job.id}) has been deactivated after failing ${MIN_FAILURE_COUNT_BEFORE_DEACTIVATION} times.`); // `_notify_admin`
    }
  }
  await cr.query("UPDATE ir_cron SET failure_count = $1, first_failure_date = $2, active = $3 WHERE id = $4", [failureCount, firstFailure, active, job.id]);
}

/** The UTC offset in minutes of `tz` at a UTC instant. */
function tzOffset(tz: string, utc: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(utc);
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  return (Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utc.getTime()) / 60000;
}

/** `relativedelta` of an interval type added to wall-clock fields (months keep the day, clamped to the month's end). */
function addInterval(wall: Date, type: string, n: number): Date {
  const d = new Date(wall.getTime());
  if (type === "months") {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + n);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
    return d;
  }
  const minutes = { minutes: 1, hours: 60, days: 1440, weeks: 10080 }[type];
  if (minutes === undefined) throw new NotPorted(`cron interval type ${type}`);
  return new Date(d.getTime() + n * minutes * 60000);
}

/**
 * `_reschedule_later`: the interval added to nextcall in the user's timezone until it is in the future (pytz
 * `context_timestamp` keeps the offset of the instant it converted, so the addition happens at that fixed offset).
 */
async function rescheduleLater(cr: Cursor, job: Job): Promise<void> {
  const nowS = (await cr.query<{ t: string }>("SELECT to_char(date_trunc('second', now() AT TIME ZONE 'UTC'), 'YYYY-MM-DD HH24:MI:SS') AS t")).rows[0]!.t;
  const tzRow = (await cr.query<{ tz: string | null }>("SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [job.user_id])).rows[0];
  const tz = tzRow?.tz || "UTC";
  const now = new Date(`${nowS.replace(" ", "T")}Z`);
  let next = new Date(`${job.nextcall.replace(" ", "T")}Z`);
  while (next.getTime() <= now.getTime()) {
    const offset = tzOffset(tz, next);
    const wall = new Date(next.getTime() + offset * 60000);
    next = new Date(addInterval(wall, job.interval_type, job.interval_number).getTime() - offset * 60000);
  }
  const iso = next.toISOString().slice(0, 19).replace("T", " ");
  await cr.query("UPDATE ir_cron SET nextcall = $1, lastcall = $2 WHERE id = $3", [iso, nowS, job.id]);
}

/**
 * ir_cron.py:152-186 `method_direct_trigger` ("Run Manually"): the job acquired even when not ready, on the request's
 * cursor, and processed as the scheduler does, its runs in their own transactions.
 */
registerMethod("ir.cron", "method_direct_trigger", async (env, ids) => {
  if (!ids || ids.length !== 1) throw new OdooError("builtins.ValueError", `Expected singleton: ir.cron(${(ids ?? []).join(", ")}${ids?.length === 1 ? "," : ""})`);
  if (!env.su) await checkModelAccess(env, env.reg.model("ir.cron"), "write");
  const id = ids[0]!;
  const job = (await env.cr.query<Job & { model: string; code: string | null; name: string }>(
    `WITH last_cron_progress AS (
       SELECT id AS progress_id, cron_id, timed_out_counter, done, remaining FROM ir_cron_progress WHERE cron_id = $1 ORDER BY id DESC LIMIT 1)
     SELECT ${JOB_COLUMNS} FROM ir_cron LEFT JOIN last_cron_progress lcp ON lcp.cron_id = ir_cron.id WHERE ir_cron.id = $1
     FOR NO KEY UPDATE SKIP LOCKED`, [id])).rows[0];
  if (!job) {
    // :166-167 the job's name (ir.actions.server `name`, translated) in base's `_()`
    const name = (await env.cr.query<{ name: string | null }>(
      `SELECT ${translatedSql("a.name", 2)} AS name FROM ir_cron c JOIN ir_act_server a ON a.id = c.ir_actions_server_id WHERE c.id = $1`, [id, langOf(env)])).rows[0]?.name ?? "";
    throw new UserError(translate(env, "Job '%s' already executing", "base").replace("%s", name));
  }
  const action = (await env.cr.query<{ id: number; model: string; code: string | null; state: string }>(
    "SELECT a.id, m.model, a.code, a.state FROM ir_act_server a JOIN ir_model m ON m.id = a.model_id WHERE a.id = $1", [job.ir_actions_server_id])).rows[0];
  if (!action) throw new NotPorted(`cron job ${id} without its server action`);
  const fn = CRON_JOBS.get(`${action.model}|${(action.code ?? "").trim()}`) ?? await codeJob(env, action);
  if (fn instanceof NotPorted) throw new NotPorted(`cron job ${id} (${action.model}: ${(action.code ?? "").trim()}): ${fn.message}`);
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("method_direct_trigger outside a request");
  // the job's cursors belong to the request (the job runs in the HTTP thread: `request` is set for its code)
  const status = await processJob(() => bindRequestCursor(ctx, env.cr.fresh()), env.cr, job, fn, ctx.env);
  // :170-185 an error logged by the run is returned as a display_exception client action
  if (status === "failed") throw new NotPorted("method_direct_trigger of a failing job (display_exception action)");
  return true;
}, { apiModel: false });

/** ir_cron.py:131-134 `_compute_cron_name`: the server action's name in English (stored). */
registerRecordCompute("ir.cron", {
  cron_name: async (env, rec) => {
    const id = Number((await rec.get("ir_actions_server_id")) || 0);
    if (!id) return false;
    const row = (await env.cr.query<{ n: string | null }>("SELECT name->>'en_US' AS n FROM ir_act_server WHERE id = $1", [id])).rows[0];
    return row?.n ?? false;
  },
});

// ir_cron.py:136-141 `create`: every new cron's server action is of usage 'ir_cron' (before this a cron of a module's
// data installed in the port kept the action's default 'ir_actions_server': measured with l10n_eu_account_vies)
registerOverrides("ir.cron", {
  create: async (env, valsList, next) => next(env, valsList.map((v) => ({ ...v, usage: "ir_cron" }))),
});
