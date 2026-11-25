/**
 * `project.task.create` (odoo/addons/project/models/project_task.py:1158-1272) with the mail.thread `create` it
 * calls (mail_thread.py:344-409, under `mail_create_nosubscribe=True`): the values the override adds, the creation
 * message posted with `project.mt_task_new` (`_creation_subtype` :1648, `_creation_message` :1651-1656), the personal
 * stages (`_populate_missing_personal_stages` :492-508) and the creator as follower.
 *
 * Ported for internal users creating private tasks and tasks in a project: the project's company and default stage,
 * date_assign/date_end/date_last_stage_update, the project followers through the relation subtypes, the portal
 * token, the assignees' followers and "You have been assigned" mails, and the stage's acknowledgment template
 * (`postStageTemplate`). Subtasks, recurrences, `default_personal_stage_type_ids`, a non-empty `display_name`, tasks
 * with a customer (the template's email), project followers with several subtypes and other templates refuse.
 */
import { addPrecommit, withPrecommit } from '../models/precommit';
import { NotPorted, OdooError } from '../errors';
import { userInfo } from '../orm/env';
import { registerOverrides, write } from '../orm/write';
import { setOverlay } from '../orm/recompute';
import type { Environment } from '../orm/types';
import { insertFollowers, messageSubscribe } from './followers';
import { notifyThread } from './notify';
import { requestOfCursor } from '../http/context';
import { isInstalled } from '../http/modules';
import { datetimeToString, dbNow, translate } from '../models/util';
import { computeAuthor, escapeText, insertMessages, messageLogBatch, replyToDefault, trackingMessageId, xmlid } from './message';
import { trackCollect, trackDiscard } from './tracking';
import { viewTerms } from './view_terms';
import { EMAIL_OUTGOING_XML } from '../orm/html_output';
import { parseHtmlFragment, serializeXml, XmlSyntaxError } from '../xml';

const REC_FIELDS = ['repeat_interval', 'repeat_unit', 'repeat_type', 'repeat_until'];

registerOverrides('project.task', {
  // the stage templates of a nested create (a parent's child_ids) are posted with the outer task's, at its end
  // (Odoo's precommit: the creation messages of all the tasks first, then the templates)
  create: (env0, valsList, next) => withPrecommit(env0.cr, () => createTasks(env0, valsList, next)),
});

async function createTasks(env0: Environment, valsList: Record<string, unknown>[], next: (env: Environment, valsList: Record<string, unknown>[]) => Promise<number[]>): Promise<number[]> {
  // project_todo/models/project_task.py:11-22, first in the MRO (before project's create below): a to-do without name,
  // project and parent in the given values (not default_project_id) is named "Untitled to-do"; with a description, its
  // first line (html2plaintext) refuses (src/orm/override_status.ts)
  if (await isInstalled(env0.cr, 'project_todo')) {
    for (const vals of valsList) {
      if (vals['name'] || vals['project_id'] || vals['parent_id']) continue;
      if (vals['description']) throw new NotPorted('project_todo create: a to-do named from its description (html2plaintext)');
      vals['name'] = translate(env0, 'Untitled to-do', 'project_todo');
    }
  }
  {
    const ctx = { ...env0.context };
    if (ctx['default_personal_stage_type_ids']) throw new NotPorted('project.task create with default_personal_stage_type_ids');
    let defaultProjectId = ctx['default_project_id'] || false;
    if (defaultProjectId !== false && typeof defaultProjectId !== 'number') throw new NotPorted('project.task default_project_id value');
    // :1179-1182 without a default project, the one parent of the new tasks gives its project
    if (!defaultProjectId) {
      const parents = [...new Set(valsList.map((v) => v['parent_id']).filter((x) => x))];
      if (parents.some((x) => typeof x !== 'number')) throw new NotPorted('project.task parent_id value');
      if (parents.length === 1) defaultProjectId = (await env0.cr.query<{ p: number | null }>('SELECT project_id AS p FROM project_task WHERE id = $1', [parents[0]])).rows[0]?.p || false;
    }
    delete ctx['default_personal_stage_type_ids']; delete ctx['default_project_id']; delete ctx['project_sharing_create'];
    const env = env0.withContext(ctx);
    // :1189-1191 self_ctx: the default project back in the context, project_sharing_create for portal users only
    const selfCtx = defaultProjectId ? env.withContext({ ...ctx, default_project_id: defaultProjectId, project_sharing_create: false }) : env;
    if (!env.su && (await userInfo(env)).share) throw new NotPorted('project.task create by a portal user (_ensure_fields_write)');
    // mail_thread.py:356-359: under tracking_disable the mail.thread create only discards the tracking
    const trackingDisabled = Boolean(env.context['tracking_disable']);
    // mail_create_nolog (mail_thread.py:382-383, the task copy) skips the creation message; the create below always
    // runs with mail_create_nosubscribe (project_task.py:1192)
    if (env.context['mail_create_nosubscribe'] === false) throw new NotPorted('project.task create with mail_create_nosubscribe=False');
    const falsyDisplayName: number[] = [];
    const createUsers: number[][] = [];
    for (const vals of valsList) {
      const projectId = vals['project_id'] || defaultProjectId;
      if (projectId !== false && typeof projectId !== 'number') throw new NotPorted('project.task project_id value');
      const now = datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000));
      // :1189-1194 assignees: date_assign, and the creator joins the assignees of a private task
      const assignees = userIdsOf(vals['user_ids']);
      // `if vals.get('user_ids')`: the commands list is truthy even when it sets no user (a copy's [Command.set([])])
      if (Array.isArray(vals['user_ids']) ? vals['user_ids'].length > 0 : Boolean(vals['user_ids'])) {
        vals['date_assign'] = now;
        if (!projectId && !assignees.includes(env.uid) && env.uid !== 1) vals['user_ids'] = [[6, 0, [...assignees, env.uid]]];
      }
      createUsers.push(userIdsOf(vals['user_ids']));
      if (REC_FIELDS.some((f) => f in vals) && vals['recurring_task'] === true) throw new NotPorted('project.task create of a recurring task');
      // :1186-1187
      if (!vals['name'] && vals['display_name']) vals['name'] = vals['display_name'];
      // display_name's inverse (_inverse_display_name :825-838) does nothing for a falsy value
      if ('display_name' in vals) {
        const dn = vals['display_name'];
        if (dn) {
          // :825-838 `_inverse_display_name`: '^(?![#!@\s]).+?(?:tags/users|priority)*$'; without '#', '@' or '!' no
          // group matches, so a match only sets name = display_name.strip() (no match: nothing)
          if (typeof dn !== 'string' || /[#@!]/.test(dn)) throw new NotPorted('project.task display_name parsing of tags, users or priority (_inverse_display_name)');
          // Python's `$` also matches before a final newline
          if (/^(?![\s]).+$/.test(dn.endsWith('\n') ? dn.slice(0, -1) : dn)) vals['name'] = dn.replace(/^\s+|\s+$/g, '');
          delete vals['display_name'];
        } else {
          delete vals['display_name'];
          falsyDisplayName.push(valsList.indexOf(vals));
        }
      }
      // personal_stage_type_id (related personal_stage_id.stage_id, readonly=False): a falsy value empties the user's
      // personal stage, which _populate_missing_personal_stages then fills: the same as not writing it
      if ('personal_stage_type_id' in vals) {
        if (vals['personal_stage_type_id']) throw new NotPorted('project.task create with a personal stage');
        delete vals['personal_stage_type_id'];
      }
      // :1211-1214 the project's company
      if (projectId && !('company_id' in vals)) {
        vals['company_id'] = (await env.cr.query<{ c: number | null }>('SELECT company_id AS c FROM project_project WHERE id = $1', [projectId])).rows[0]?.c ?? false;
      }
      // :1215-1216 no project: no stage
      if (!projectId && ('stage_id' in vals || env.context['default_stage_id'])) vals['stage_id'] = false;
      // :1218-1226 `default_get(['stage_id'])` with default_project_id: the context default, else
      // `_get_default_stage_id` (:122-127, project_project.py:1151-1157 `_get_default_task_stage`)
      if (projectId && !('stage_id' in vals)) {
        if (env.context['copy_from_template']) throw new NotPorted('project.task create with copy_from_template');
        const ctxStage = env.context['default_stage_id'];
        vals['stage_id'] = ctxStage !== undefined ? ctxStage : await defaultTaskStage(env, projectId);
      }
      // :1228-1231 a stage: date_end (folded stage) and date_last_stage_update
      if (vals['stage_id']) {
        if (typeof vals['stage_id'] !== 'number') throw new NotPorted('project.task stage_id value');
        const fold = (await env.cr.query<{ fold: boolean | null }>('SELECT fold FROM project_task_type WHERE id = $1', [vals['stage_id']])).rows[0]?.fold;
        vals['date_end'] = fold ? now : false;
        vals['date_last_stage_update'] = now;
      }
    }
    // super(ProjectTask, self_ctx.with_context(mail_create_nosubscribe=True)).create(vals_list)
    const tenv = selfCtx.withContext({ ...selfCtx.context, mail_create_nosubscribe: true });
    // mail_thread.py:372-379 create_values: the values with the context defaults they lack
    const createValues = valsList.map((vals) => {
      const cv: Record<string, unknown> = { ...vals };
      for (const [k, v] of Object.entries(tenv.context)) if (k.startsWith('default_') && !(k.slice(8) in cv)) cv[k.slice(8)] = v;
      return cv;
    });
    const ids = await next(tenv, valsList);
    // the written (falsy) display_name stays in the cache for the rest of the transaction (models.py create:
    // inversed fields are put in cache, `_inverse_display_name` ignores them)
    for (const i of falsyDisplayName) setOverlay(env, 'project.task', 'display_name', [ids[i]!], false);
    if (trackingDisabled) await trackDiscard(tenv, 'project.task', ids);
    else await mailThreadCreate(tenv, ids, createUsers, createValues);
    await populateMissingPersonalStages(env.sudo(), ids);
    // :1229 _task_message_auto_subscribe_notify({task: task.user_ids - env.user})
    if (!env.context['mail_auto_subscribe_no_notify']) {
      for (let i = 0; i < ids.length; i++) {
        const others = createUsers[i]!.filter((u) => u !== env.uid);
        if (others.length > 1) throw new NotPorted('project.task assignment notifications to several users (user_ids order)');
        for (const u of others) await notifyAssigned(env, ids[i]!, u, falsyDisplayName.includes(i));
      }
    }
    // :1259-1260 `_set_stage_on_project_from_task`: a stage outside the task's project joins it (not ported)
    const outside = (await env.cr.query(
      `SELECT 1 FROM project_task t WHERE t.id = ANY($1::int[]) AND t.stage_id IS NOT NULL AND t.project_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM project_task_type_rel r WHERE r.type_id = t.stage_id AND r.project_id = t.project_id) LIMIT 1`, [ids])).rows.length;
    if (outside) throw new NotPorted('project.task created in a stage of another project (_set_stage_on_project_from_task)');
    // :1261-1267 the portal token of tasks in portal projects (`_portal_ensure_token` :2358-2362, a uuid4), then
    // the creator follows the task (message_subscribe, project.task override :510-528)
    const partner = (await userInfo(env)).partnerId;
    for (const id of ids) {
      const privacy = (await env.cr.query<{ p: string | null }>(
        'SELECT p.privacy_visibility AS p FROM project_task t JOIN project_project p ON p.id = t.project_id WHERE t.id = $1', [id])).rows[0]?.p ?? null;
      if (privacy === 'portal') await env.cr.query('UPDATE project_task SET access_token = $2 WHERE id = $1 AND access_token IS NULL', [id, crypto.randomUUID()]);
      // :1264-1265 the parent's followers follow the subtask with their subtypes
      const parent = (await env.cr.query<{ p: number | null }>('SELECT parent_id AS p FROM project_task WHERE id = $1', [id])).rows[0]?.p ?? null;
      if (parent !== null) {
        const followers = (await env.cr.query<{ id: number; partner_id: number | null }>(
          "SELECT id, partner_id FROM mail_followers WHERE res_model = 'project.task' AND res_id = $1 ORDER BY id", [parent])).rows;
        for (const f of followers) {
          if (f.partner_id === null) throw new NotPorted('project.task parent follower without partner');
          const subtypes = (await env.cr.query<{ s: number }>(
            'SELECT mail_message_subtype_id AS s FROM mail_followers_mail_message_subtype_rel WHERE mail_followers_id = $1 ORDER BY mail_message_subtype_id', [f.id])).rows.map((r) => r.s);
          if (!subtypes.length) throw new NotPorted('project.task parent follower without subtypes (message_subscribe defaults)');
          await messageSubscribe(env.sudo(), 'project.task', [id], [f.partner_id], subtypes);
        }
      }
      const follows = (await env.cr.query("SELECT 1 FROM mail_followers WHERE res_model = 'project.task' AND res_id = $1 AND partner_id = $2", [id, partner])).rows.length;
      if (!follows) await messageSubscribe(env.sudo(), 'project.task', [id], [partner], null);
    }
    // mail_thread.py:399-409 `_track_prepare_for_template` with the truthy tracked create values; the template
    // messages are posted when the create returns (the documented difference to Odoo's precommit)
    // at precommit when the caller has a precommit scope (sale_project's confirmation: after the order's tracking),
    // else when the create returns (the documented difference to Odoo's precommit)
    if (!trackingDisabled) for (let i = 0; i < ids.length; i++) if (createValues[i]!['stage_id']) { const id = ids[i]!; await addPrecommit(env.cr, () => postStageTemplate(tenv, id)); }
    return ids;
  }
}

/** mail_message_subtype.py:47-71 `_get_auto_subscription_subtypes('project.task')` (search order: sequence, id). */
async function taskAutoSubtypes(env: Environment): Promise<{ childIds: number[]; defIds: number[]; internalIds: number[]; parent: Map<number, number>; relation: Map<string, Set<string>> }> {
  const rows = (await env.cr.query<{ id: number; res_model: string | null; default: boolean | null; internal: boolean | null; relation_field: string | null; parent_id: number | null }>(
    `SELECT s.id, s.res_model, s."default", s.internal, s.relation_field, s.parent_id FROM mail_message_subtype s
       LEFT JOIN mail_message_subtype p ON p.id = s.parent_id
      WHERE s.res_model IS NULL OR s.res_model = 'project.task' OR p.res_model = 'project.task' ORDER BY s.sequence, s.id`)).rows;
  const out = { childIds: [] as number[], defIds: [] as number[], internalIds: [] as number[], parent: new Map<number, number>(), relation: new Map<string, Set<string>>() };
  for (const s of rows) {
    if (!s.res_model || s.res_model === 'project.task') {
      out.childIds.push(s.id);
      if (s.default) out.defIds.push(s.id);
    }
    if (s.relation_field) {
      out.parent.set(s.id, s.parent_id ?? 0);
      const set = out.relation.get(s.res_model ?? '') ?? new Set<string>();
      set.add(s.relation_field);
      out.relation.set(s.res_model ?? '', set);
    }
    if (s.internal) out.internalIds.push(s.id);
  }
  return out;
}

/** mail_thread.py:344-409 with mail_create_nosubscribe: auto-subscription and the creation message. */
async function mailThreadCreate(env: Environment, ids: readonly number[], createUsers: readonly number[][],
  createValues: readonly Record<string, unknown>[]): Promise<void> {
  // `_message_auto_subscribe(create_values, 'update')` (mail_thread.py:5008-5075): the followers of the parent
  // documents (the project) through the relation subtypes, then project.task `_message_auto_subscribe_followers`
  // (:1620-1636): the partners of `user_ids` with the default subtypes
  const sub = await taskAutoSubtypes(env);
  for (let i = 0; i < ids.length; i++) {
    const values = createValues[i]!;
    const newSubtypes = new Map<number, number[]>();
    for (const [resModel, fnames] of sub.relation) {
      for (const fname of fnames) {
        const docId = values[fname];
        if (!docId) continue;
        if (typeof docId !== 'number') throw new NotPorted(`auto-subscription through ${fname} = ${JSON.stringify(docId)}`);
        // mail_followers.py `_get_subscription_data(doc_data, None, include_pshare=True, include_active=True)`
        const rows = (await env.cr.query<{ partner_id: number | null; sids: number[] | null; pshare: boolean | null; active: boolean | null }>(
          `SELECT f.partner_id, array_remove(array_agg(r.mail_message_subtype_id ORDER BY r.mail_message_subtype_id), NULL) AS sids,
                  p.partner_share AS pshare, p.active
             FROM mail_followers f LEFT JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
             LEFT JOIN res_partner p ON p.id = f.partner_id
            WHERE f.res_model = $1 AND f.res_id = $2 GROUP BY f.id, p.partner_share, p.active ORDER BY f.id`, [resModel, docId])).rows;
        for (const r of rows) {
          const sids = r.sids ?? [];
          let mapped = [...new Set([...sids.filter((x) => sub.parent.get(x)).map((x) => sub.parent.get(x)!), ...sids.filter((x) => !sub.parent.has(x) && sub.childIds.includes(x))])];
          if (r.pshare) mapped = mapped.filter((x) => !sub.internalIds.includes(x));
          // a Python set: its iteration order (the subtype rows' insertion order) is only known for one element
          if (mapped.length > 1) throw new NotPorted('project.task auto-subscription of project followers with several subtypes (set order)');
          if (r.partner_id && r.active) newSubtypes.set(r.partner_id, mapped);
        }
      }
    }
    const users = createUsers[i]!;
    if (users.length) {
      const partners = (await env.cr.query<{ id: number; partner_id: number }>('SELECT id, partner_id FROM res_users WHERE id = ANY($1::int[])', [users])).rows;
      for (const u of users) {
        const p = partners.find((r) => r.id === u)?.partner_id;
        if (typeof p === 'number' && !newSubtypes.has(p)) newSubtypes.set(p, sub.defIds);
      }
    }
    if (newSubtypes.size) {
      await insertFollowers(env.sudo(), 'project.task', [ids[i]!], [...newSubtypes.keys()], newSubtypes, { checkExisting: true, policy: 'update' });
    }
  }
  // mail_thread.py:382 `if not self.env.context.get('mail_create_nolog')`
  if (env.context['mail_create_nolog']) return;
  const subtype = await xmlid(env, 'project.mt_task_new');
  const [authorId, emailFrom] = await computeAuthor(env, (await userInfo(env)).partnerId, null);
  const replyTo = await replyToDefault(env, emailFrom);
  for (const id of ids) {
    // thread.sudo().message_post(subtype_id=mt_task_new, author_id=user.partner_id, body=<div><p>...</p></div>)
    const followers = (await env.cr.query(
      `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
        WHERE f.res_model = 'project.task' AND f.res_id = $1 AND r.mail_message_subtype_id = $2 LIMIT 1`, [id, subtype])).rows.length;
    if (followers) throw new NotPorted('project.task creation message with followers to notify');
    // :1651-1656 `_creation_message`: `_()` of project's module in the writer's language (rådet runda 13: before, every
    // language but en_US refused; the Swedish .po leaves both texts untranslated); the Markup escapes the text, which
    // the Html field stores with its quotes as such (escapeText)
    const project = (await env.cr.query<{ p: number | null }>('SELECT project_id AS p FROM project_task WHERE id = $1', [id])).rows[0]?.p ?? null;
    const text = project === null ? escapeText(translate(env, 'This new task is not part of any project.', 'project'))
      : escapeText(translate(env, 'This new task has been created in the "%(project_name)s" project.', 'project')
        .replace('%(project_name)s', (await env.sudo().model('project.project').displayName([project])).get(project) ?? ''));
    await insertMessages(env.sudo(), [{
      model: 'project.task', res_id: id, body: `<div><p>${text}</p></div>`,
      author_id: authorId, email_from: emailFrom, message_type: 'notification', subtype_id: subtype,
      reply_to: replyTo, message_id: trackingMessageId('message-notify'), email_add_signature: true,
      // mail_thread.py:2420-2421 `_mail_get_companies(default=env.company)`: the task's company, else the env's
      record_company_id: (await env.cr.query<{ c: number | null }>('SELECT company_id AS c FROM project_task WHERE id = $1', [id])).rows[0]?.c ?? await env.company(),
    }]);
  }
  await trackDiscard(env, 'project.task', ids);
}

/** project_task.py:492-508 `_populate_missing_personal_stages` (as superuser). */
async function populateMissingPersonalStages(env: Environment, ids: readonly number[]): Promise<void> {
  const rows = (await env.cr.query<{ id: number; user_id: number }>(
    'SELECT id, user_id FROM project_task_user_rel WHERE task_id = ANY($1::int[]) AND stage_id IS NULL ORDER BY id', [ids])).rows;
  const users = [...new Set(rows.map((r) => r.user_id))];
  for (const uid of users) {
    const stage = (await env.cr.query<{ id: number }>('SELECT id FROM project_task_type WHERE user_id = $1 AND active IS TRUE ORDER BY sequence, id LIMIT 1', [uid])).rows[0];
    if (!stage) throw new NotPorted("creating a user's default personal stages (_get_default_personal_stage_create_vals)");
    await env.cr.query(
      `UPDATE project_task_user_rel SET stage_id = $1, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($3::int[])`,
      [stage.id, env.uid, rows.filter((r) => r.user_id === uid).map((r) => r.id)]);
  }
}

/**
 * project_task.py:1274-1460 for a write of `project_id` alone (a project copy's `map_tasks` moving the copied subtasks,
 * project_project.py:524-528): the followers of the target project with the "Task Created" subtype would be notified
 * of the transfer (:1370-1383, refused), portal assignees not following it would be removed (:1384-1388, refused); the
 * tasks and their subtasks whose stage the write changed reopen unless waiting or closed (:1430-1438).
 */
async function writeProject(env: Environment, ids: readonly number[], vals: Record<string, unknown>, next: (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>): Promise<void> {
  if (Object.keys(vals).some((k) => k !== 'project_id')) throw new NotPorted(`project.task write of project_id with ${Object.keys(vals).filter((k) => k !== 'project_id').join(', ')}`);
  const projectId = vals['project_id'];
  if (projectId !== false && typeof projectId !== 'number') throw new NotPorted('project.task project_id value');
  if (projectId) {
    const notified = (await env.cr.query(
      `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
         JOIN ir_model_data d ON d.model = 'mail.message.subtype' AND d.res_id = r.mail_message_subtype_id AND d.module = 'project' AND d.name = 'mt_project_task_new'
        WHERE f.res_model = 'project.project' AND f.res_id = $1 LIMIT 1`, [projectId])).rows.length;
    if (notified) throw new NotPorted('project.task transferred to a project with followers of new tasks (message_notify)');
    const portal = (await env.cr.query(
      'SELECT 1 FROM project_task_user_rel r JOIN res_users u ON u.id = r.user_id WHERE r.task_id = ANY($1::int[]) AND u.share LIMIT 1', [[...ids]])).rows.length;
    if (portal) throw new NotPorted('project.task transferred with portal assignees (removed unless following the project)');
  }
  // :1397-1399 the tasks and their subtasks, with their stages before the write
  const before = (await env.cr.query<{ id: number; stage_id: number | null }>(
    `WITH RECURSIVE tree AS (SELECT id FROM project_task WHERE id = ANY($1::int[])
       UNION SELECT t.id FROM project_task t JOIN tree ON t.parent_id = tree.id)
     SELECT t.id, t.stage_id FROM tree JOIN project_task t ON t.id = tree.id ORDER BY t.id`, [[...ids]])).rows;
  await next(env, ids, vals);
  const after = (await env.cr.query<{ id: number; stage_id: number | null; state: string | null }>(
    'SELECT id, stage_id, state FROM project_task WHERE id = ANY($1::int[]) ORDER BY id', [before.map((r) => r.id)])).rows;
  const reopen = after.filter((t) => t.state !== '04_waiting_normal' && !['1_done', '1_canceled'].includes(t.state ?? '')
    && before.find((b) => b.id === t.id)?.stage_id !== t.stage_id).map((t) => t.id);
  if (reopen.length) await write(env, 'project.task', reopen, { state: '01_in_progress' });
}

registerOverrides('project.task', {
  // project_task.py:1274-1460 for stage_id and state; the other keys of the override refuse in write_hooks.ts
  write: async (env, ids, vals, next) => {
    if ('project_id' in vals) return writeProject(env, ids, vals, next);
    if (!('stage_id' in vals) && !('state' in vals) && !('user_ids' in vals)) return next(env, ids, vals);
    const now = datetimeToString(new Date(Math.floor((await dbNow(env)).getTime() / 1000) * 1000));
    const stageChange = 'stage_id' in vals, stateChange = 'state' in vals, usersChange = 'user_ids' in vals;
    // :1343-1345 the tasks without assignees (date_assign follows), :1363-1364 the assignees before the write
    const assignees = async (): Promise<Map<number, number[]>> => {
      const rows = (await env.cr.query<{ task_id: number; user_id: number }>('SELECT task_id, user_id FROM project_task_user_rel WHERE task_id = ANY($1::int[]) ORDER BY user_id', [[...ids]])).rows;
      return new Map(ids.map((id) => [id, rows.filter((r) => r.task_id === id).map((r) => r.user_id)]));
    };
    const oldUsers = usersChange ? await assignees() : new Map<number, number[]>();
    const w = { ...vals };
    if (stageChange) {
      if (!('project_id' in w)) {
        // :1336-1338
        const free = (await env.cr.query('SELECT 1 FROM project_task WHERE id = ANY($1::int[]) AND project_id IS NULL LIMIT 1', [[...ids]])).rows.length;
        if (free) throw new OdooError('odoo.exceptions.UserError', 'You can only set a personal stage on a private task.');
      }
      if (typeof w['stage_id'] !== 'number' && w['stage_id'] !== false) throw new NotPorted('project.task stage_id value');
      const fold = w['stage_id'] ? (await env.cr.query<{ fold: boolean | null }>('SELECT fold FROM project_task_type WHERE id = $1', [w['stage_id']])).rows[0]?.fold : false;
      w['date_end'] = fold ? now : false; // :1482-1486 update_date_end
      w['date_last_stage_update'] = now;
    }
    await next(env, ids, w);
    if (usersChange) {
      // :1411-1419 the personal stages of the new assignees, then date_assign (as superuser, a plain write)
      await populateMissingPersonalStages(env.sudo(), ids);
      const users = await assignees();
      for (const id of ids) {
        const [t] = (await env.cr.query<{ d: string | null }>('SELECT date_assign::text AS d FROM project_task WHERE id = $1', [id])).rows;
        if (!users.get(id)!.length && t?.d) await next(env.sudo(), [id], { date_assign: false });
        // :1343-1345, :1419-1420 a task without assignees before the write gets date_assign, assigned or not after it
        else if (!('date_assign' in vals) && !oldUsers.get(id)!.length) await next(env.sudo(), [id], { date_assign: now });
      }
    }
    if (stageChange && w['stage_id']) {
      // :1419-1420 rating on stage; project_sms project_task.py:24-29 the stage's SMS
      const special = (await env.cr.query(
        `SELECT 1 FROM project_task t JOIN project_task_type s ON s.id = t.stage_id
          WHERE t.id = ANY($1::int[]) AND ((s.rating_active AND s.rating_status = 'stage') OR (s.sms_template_id IS NOT NULL AND t.partner_id IS NOT NULL)) LIMIT 1`, [[...ids]])).rows.length;
      if (special) throw new NotPorted('project.task stage with a rating request or an SMS');
    }
    if (stateChange) {
      // :1422-1428 a forced open state of a blocked task goes back to waiting
      const next2 = String(w['state']);
      if (!['1_done', '1_canceled', '04_waiting_normal'].includes(next2)) {
        const blocked = (await env.cr.query(
          `SELECT 1 FROM project_task t JOIN project_project p ON p.id = t.project_id JOIN task_dependencies_rel d ON d.task_id = t.id JOIN project_task b ON b.id = d.depends_on_id
            WHERE t.id = ANY($1::int[]) AND p.allow_task_dependencies IS TRUE AND b.state NOT IN ('1_done', '1_canceled') LIMIT 1`, [[...ids]])).rows.length;
        if (blocked) throw new NotPorted('project.task forced open state of a blocked task');
      }
      await env.cr.query('UPDATE project_task SET date_last_stage_update = $2 WHERE id = ANY($1::int[])', [[...ids], now]);
    } else if (stageChange) {
      // :1441-1442 the stage change reopens the task (a second tracked change: Odoo logs both in one message)
      const reopen = (await env.cr.query(
        "SELECT 1 FROM project_task WHERE id = ANY($1::int[]) AND state NOT IN ('04_waiting_normal', '1_done', '1_canceled', '01_in_progress') LIMIT 1", [[...ids]])).rows.length;
      if (reopen) throw new NotPorted('project.task stage change resetting the state');
    }
    // :1450 `_task_message_auto_subscribe_notify` of the new assignees but the current user
    if (usersChange && !env.context['mail_auto_subscribe_no_notify']) {
      const users = await assignees();
      for (const id of ids) {
        const added = users.get(id)!.filter((u) => !oldUsers.get(id)!.includes(u) && u !== env.uid);
        if (added.length > 1) throw new NotPorted('project.task assignment notifications to several users (user_ids order)');
        for (const u of added) await notifyAssigned(env, id, u, false);
      }
    }
  },
  inverse: {
    // project_task.py:383-388 _inverse_parent_id: a task without parent shows in the project, a subtask in its parent's
    // project does not
    parent_id: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; parent_id: number | null; d: boolean | null; same: boolean }>(
        `SELECT t.id, t.parent_id, t.display_in_project AS d, (t.project_id IS NOT DISTINCT FROM p.project_id) AS same
           FROM project_task t LEFT JOIN project_task p ON p.id = t.parent_id WHERE t.id = ANY($1::int[]) ORDER BY t.id`, [[...ids]])).rows;
      for (const r of rows) {
        if (r.parent_id === null) { if (!r.d) await write(env.sudo(), 'project.task', [r.id], { display_in_project: true }); }
        else if (r.d && r.same) await write(env.sudo(), 'project.task', [r.id], { display_in_project: false });
      }
    },
    // sale_project project_task.py:122-132 _inverse_partner_id: a customer outside the sale order's partners clears it
    partner_id: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; mine: number | null; a: number | null; b: number | null; c: number | null }>(
        `SELECT t.id, tp.commercial_partner_id AS mine, pa.commercial_partner_id AS a, pb.commercial_partner_id AS b, pc.commercial_partner_id AS c
           FROM project_task t JOIN sale_order o ON o.id = t.sale_order_id LEFT JOIN res_partner tp ON tp.id = t.partner_id
           LEFT JOIN res_partner pa ON pa.id = o.partner_id LEFT JOIN res_partner pb ON pb.id = o.partner_invoice_id LEFT JOIN res_partner pc ON pc.id = o.partner_shipping_id
          WHERE t.id = ANY($1::int[])`, [[...ids]])).rows;
      for (const r of rows) {
        // `task.partner_id.commercial_partner_id not in consistent_partners`: an empty partner is "in" an empty set only
        if (r.mine !== null && [r.a, r.b, r.c].includes(r.mine)) continue;
        throw new NotPorted('project.task customer outside its sale order (_inverse_partner_id clears the sale order and line)');
      }
    },
    // project_task.py:685-688 _inverse_partner_phone: the customer gets the task's number
    partner_phone: async (env, ids) => {
      const rows = (await env.cr.query<{ partner_id: number | null; partner_phone: string | null }>(
        'SELECT partner_id, partner_phone FROM project_task WHERE id = ANY($1::int[]) ORDER BY id', [[...ids]])).rows;
      for (const r of rows) if (r.partner_id !== null) await write(env, 'res.partner', [r.partner_id], { phone: r.partner_phone ?? false });
    },
    // project_task.py:457-460 _inverse_state: the next occurrence of a closed recurring task (not ported)
    state: async (env, ids) => {
      const closed = (await env.cr.query(
        `SELECT 1 FROM project_task WHERE id = ANY($1::int[]) AND recurrence_id IS NOT NULL AND state IN ('1_done', '1_canceled') LIMIT 1`, [[...ids]])).rows.length;
      if (closed) throw new NotPorted('project.task next occurrence of a closed recurring task (_create_next_occurrences)');
    },
  },
});

/**
 * The res.users ids of a `user_ids` value read from an empty record, as fields_relational.py:648-688 `convert_to_cache`
 * does (project_task.py:1625-1626 `_message_auto_subscribe_followers`, the create values): SET replaces, LINK and
 * UPDATE add, UNLINK and DELETE discard, CLEAR empties; CREATE (a new user) refuses.
 */
export function userIdsOf(value: unknown): number[] {
  if (!value) return [];
  if (!Array.isArray(value)) throw new NotPorted('project.task user_ids value');
  const out: number[] = [];
  const add = (id: number): void => { if (!out.includes(id)) out.push(id); };
  for (const c of value) {
    if (typeof c === 'number') { add(c); continue; }
    if (!Array.isArray(c)) throw new NotPorted('project.task user_ids command');
    if (c[0] === 6 && Array.isArray(c[2])) { out.length = 0; for (const id of c[2] as number[]) add(id); }
    else if ((c[0] === 4 || c[0] === 1) && typeof c[1] === 'number') add(c[1]);
    else if ((c[0] === 3 || c[0] === 2) && typeof c[1] === 'number') { const i = out.indexOf(c[1]); if (i >= 0) out.splice(i, 1); }
    else if (c[0] === 5) out.length = 0;
    else throw new NotPorted(`project.task user_ids command ${JSON.stringify(c[0])}`);
  }
  return out;
}

/**
 * project_task.py:1586-1612 `_task_message_auto_subscribe_notify` for one assignee: the
 * `project.project_message_user_assigned` body (mail_template_data.xml:120-126) through `message_notify`.
 * `display_name` is the cached value: False when the create values carried a falsy display_name.
 */
async function notifyAssigned(env: Environment, taskId: number, userId: number, falsyDisplayName: boolean): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('assignment notification outside a request');
  const user = (await env.cr.query<{ name: string | null; partner_id: number }>(
    'SELECT p.name, u.partner_id FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1', [userId])).rows[0]!;
  // `ir.model._get(...).display_name` and the QWeb template in the writer's language (ir_qweb renders the view's
  // arch_db in env.lang; its terms, src/mail/view_terms.ts, are already escaped XML text and stay as they are)
  const lang = env.lang ?? 'en_US';
  const modelDescription = (await env.cr.query<{ name: string }>(
    "SELECT COALESCE(name->>$1, name->>'en_US', model) AS name FROM ir_model WHERE model = 'project.task'", [lang])).rows[0]!.name;
  const term = await viewTerms(env, ['project.project_message_user_assigned']);
  const displayName = falsyDisplayName ? false : (await env.sudo().model('project.task').displayName([taskId])).get(taskId) ?? '';
  // QWeb t-out of False renders nothing; html_sanitize keeps the markup as below
  const body = `<div>\n    ${term('Dear')} ${escapeText(user.name ?? '')},\n    <br><br>\n    <span style="margin-top:8px">${term('You have been assigned to the')} ${escapeText(modelDescription || 'document')} ${displayName === false ? '' : escapeText(displayName)}.</span>\n</div>`;
  const [authorId, emailFrom] = await computeAuthor(env, null, null);
  const company = (await env.cr.query<{ c: number | null }>('SELECT company_id AS c FROM project_task WHERE id = $1', [taskId])).rows[0]?.c ?? await env.company();
  const [mid] = await insertMessages(env, [{
    model: 'project.task', res_id: taskId, body, author_id: authorId, email_from: emailFrom, message_type: 'user_notification',
    subtype_id: await xmlid(env, 'mail.mt_note'), is_internal: true,
    // project_task.py:1606 `_('You have been assigned to %s', task.display_name)`
    subject: translate(env, 'You have been assigned to %s', 'project').replace('%s', displayName === false ? 'False' : displayName),
    reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId('message-notify'), email_add_signature: true,
    record_alias_domain_id: false, record_company_id: company, email_layout_xmlid: 'mail.mail_notification_layout', partner_ids: [user.partner_id],
  }]);
  // the layout's record name is the cached display_name too (mail_thread.py `_notify_get_classified_recipients_iterator`)
  const notified = await notifyThread(ctx, env, 'project.task', taskId, mid!, { modelDescription, layoutRecordName: displayName === false ? '' : displayName });
  await notified.send();
}

/** project_project.py:1151-1157 `_get_default_task_stage`: the project's first stage (booleans order as false when NULL). */
async function defaultTaskStage(env: Environment, projectId: number): Promise<number | false> {
  return (await env.cr.query<{ id: number }>(
    `SELECT t.id FROM project_task_type t JOIN project_task_type_rel r ON r.type_id = t.id
      WHERE r.project_id = $1 AND t.active IS TRUE ORDER BY COALESCE(t.fold, false), t.sequence, t.id LIMIT 1`, [projectId])).rows[0]?.id ?? false;
}

/** project/data/mail_template_data.xml `mail_template_data_project_task` (Project: Request Acknowledgment) as stored
 *  before Odoo 9710d237f (XML); compared as a tree (isAckBody), so the HTML serialization after it matches too. */
const ACK_BODY = `<div>
    Dear <t t-out="object.partner_id.name or 'customer'">Brandon Freeman</t>,<br/><br/>
    Thank you for contacting us. We appreciate your interest in our products/services.<br/>
    Our team is currently reviewing your inquiry and will respond to your email as soon as possible.<br/>
    If you have any further questions or concerns in the meantime, please do not hesitate to let us know. We are here to help.<br/><br/>
    Thank you for your patience.<br/>
    Best regards,
    <t t-if="user.signature">
        <br/>
        <div data-o-mail-quote="1">--<br data-o-mail-quote="1"/><t t-out="user.signature or ''">Mitchell Admin</t></div>
    </t>
</div>
        `;

/** The tree of a template body as Odoo parses it (lxml.html), in one serialization; null when the port refuses it. */
function bodyTree(body: string): string | null {
  try {
    return serializeXml(parseHtmlFragment(body));
  } catch (e) {
    if (e instanceof XmlSyntaxError) return null;
    throw e;
  }
}
let ackTree: string | null | undefined;
/** Whether a stored body is the stock acknowledgment: the same lxml.html tree as ACK_BODY, whichever serialization. */
function isAckBody(body: unknown): boolean {
  ackTree ??= bodyTree(ACK_BODY);
  return typeof body === 'string' && ackTree !== null && bodyTree(body) === ackTree;
}

/**
 * The acknowledgment body rendered for the task's customer (else `'customer'`) as the composer stores it and as the
 * message keeps it after the Html field's sanitize (`<br>`, no quote container), for a user signature that is empty
 * or a single text-only `<div>` (the forms checked against Odoo; others refuse).
 */
function ackBodies(signature: string | null, customer: string | null): { composer: string; message: string } {
  const lines = [
    'Thank you for contacting us. We appreciate your interest in our products/services.<br/>',
    'Our team is currently reviewing your inquiry and will respond to your email as soon as possible.<br/>',
    'If you have any further questions or concerns in the meantime, please do not hesitate to let us know. We are here to help.<br/><br/>',
    'Thank you for your patience.<br/>',
    'Best regards,',
  ];
  let inner = `\n    Dear ${customer === null ? 'customer' : escapeText(customer)},<br/><br/>\n    ${lines.join('\n    ')}`;
  let container = '';
  if (signature) {
    const m = /^<div>([^<>&]*)<\/div>$/.exec(signature);
    if (!m) throw new NotPorted('acknowledgment template with this user signature (QWeb rendering and quote marking)');
    inner += `\n        <br/>\n        <div data-o-mail-quote="1">--<br data-o-mail-quote="1"/><div data-o-mail-quote="1">${m[1]}</div></div>`;
    container = ' data-o-mail-quote-container="1"';
  }
  // the composer's body is an email_outgoing field: XML before Odoo 9710d237f, HTML (`<br>`) after (orm/html_output.ts)
  const html = (x: string): string => x.replace(/<br( data-o-mail-quote="1")?\/>/g, '<br$1>');
  const composerXml = `<div${container}>${inner}\n</div>\n        `;
  const composer = EMAIL_OUTGOING_XML ? composerXml : html(composerXml);
  const message = html(`<div>${inner}\n</div>\n        `);
  return { composer, message };
}

/**
 * mail_thread.py:747-776 `_track_post_template` for a task whose stage has a mail template (project_task.py:1638-1646
 * `_track_template_parameters`): `message_post_with_source(template, subtype mt_note, message_type 'auto_comment',
 * auto_delete_keep_log False, notify_author_mention True)` in comment mode, i.e. a mail.compose.message
 * (wizard/mail_compose_message.py) rendering the template and posting. Ported for the stock acknowledgment template
 * on a task without default recipients and without followers to notify.
 */
async function postStageTemplate(env0: Environment, taskId: number): Promise<void> {
  // _track_finalize_for_template: clean context, superuser
  const env = env0.withContext(Object.fromEntries(Object.entries(env0.context).filter(([k]) => !k.startsWith('default_')))).sudo();
  const task = (await env.cr.query<{ template: number | null; is_template: boolean | null; partner_id: number | null; email_from: string | null; name: string; company_id: number | null }>(
    `SELECT s.mail_template_id AS template, t.is_template, t.partner_id, t.email_from, t.name, t.company_id
       FROM project_task t LEFT JOIN project_task_type s ON s.id = t.stage_id WHERE t.id = $1`, [taskId])).rows[0];
  if (!task || task.template === null || task.is_template) return;
  const tpl = (await env.cr.query<Record<string, unknown>>(
    `SELECT body_html->>'en_US' AS body, subject->>'en_US' AS subject, email_layout_xmlid, use_default_to, email_from, email_to, email_cc,
            partner_to, partner_cc, reply_to, lang, scheduled_date, mail_server_id, auto_delete, active,
            (SELECT count(*) FROM email_template_attachment_rel a WHERE a.email_template_id = mail_template.id)::int AS atts,
            (SELECT count(*) FROM mail_template_ir_actions_report_rel a WHERE a.mail_template_id = mail_template.id)::int AS reports
       FROM mail_template WHERE id = $1`, [task.template])).rows[0];
  if (!tpl || !isAckBody(tpl['body']) || tpl['subject'] !== 'Reception of {{ object.name }}' || tpl['email_layout_xmlid'] !== 'mail.mail_notification_light'
    || tpl['use_default_to'] !== true || tpl['email_from'] || tpl['email_to'] || tpl['email_cc'] || tpl['partner_to'] || tpl['partner_cc'] || tpl['reply_to'] || tpl['lang']
    || tpl['scheduled_date'] || tpl['mail_server_id'] || Number(tpl['atts']) || Number(tpl['reports']) || tpl['auto_delete'] !== true) {
    throw new NotPorted('stage mail templates other than the stock acknowledgment (mail.compose.message rendering)');
  }
  // use_default_to: `_message_get_default_recipients` (mail/models/models.py:287-360): the customer with an email
  const customer = task.partner_id === null ? null : (await env.cr.query<{ name: string | null; email_normalized: string | null }>(
    'SELECT name, email_normalized FROM res_partner WHERE id = $1', [task.partner_id])).rows[0] ?? null;
  if (task.partner_id === null ? task.email_from : !customer?.email_normalized) throw new NotPorted('acknowledgment template sent to an email address (no customer with an email)');
  if (env.lang && env.lang !== 'en_US') throw new NotPorted(`translated acknowledgment template (${env.lang})`);
  const note = await xmlid(env, 'mail.mt_note');
  const notified = (await env.cr.query(
    `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
      WHERE f.res_model = 'project.task' AND f.res_id = $1 AND r.mail_message_subtype_id = $2 LIMIT 1`, [taskId, note])).rows.length;
  if (notified) throw new NotPorted('acknowledgment template with followers of internal notes to notify');
  // `user` of the rendering context: the request's user (sudo keeps env.uid)
  const signature = (await env.cr.query<{ s: string | null }>('SELECT signature AS s FROM res_users WHERE id = $1', [env.uid])).rows[0]?.s ?? null;
  const bodies = ackBodies(signature, customer?.name ?? null);
  const subject = `Reception of ${task.name}`;
  const [authorId, emailFrom] = await computeAuthor(env, (await userInfo(env)).partnerId, null);
  const company = task.company_id ?? await env.company();
  const composer = (await env.cr.query<{ id: number }>(
    `INSERT INTO mail_compose_message (template_id, author_id, record_company_id, subtype_id, subject, email_layout_xmlid, email_from,
       composition_mode, model, message_type, body, res_ids, email_notification_allow_header, email_add_signature, reply_to_force_new,
       auto_delete, auto_delete_keep_log, force_send, notify_author_mention, use_exclusion_list, create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, $4, $5, 'mail.mail_notification_light', $6, 'comment', 'project.task', 'auto_comment', $7, $8,
       true, false, false, true, false, true, true, true, $9, $9, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
    [task.template, authorId === false ? null : authorId, company, note, subject, emailFrom === false ? null : emailFrom, bodies.composer, `[${taskId}]`, env.uid])).rows[0]!.id;
  if (task.partner_id !== null) {
    await env.cr.query('INSERT INTO mail_compose_message_res_partner_rel (wizard_id, partner_id) VALUES ($1, $2)', [composer, task.partner_id]);
    // mail_thread.py:2382-2386 `_mail_thread_customer` (project_task.py:104): the customer recipient follows the
    // task; message_subscribe's override (:510-520) takes a project follower's subtypes
    const project = (await env.cr.query("SELECT 1 FROM mail_followers f JOIN project_task t ON t.project_id = f.res_id WHERE f.res_model = 'project.project' AND t.id = $1 AND f.partner_id = $2 LIMIT 1", [taskId, task.partner_id])).rows.length;
    if (project) throw new NotPorted('customer following the project (project.task message_subscribe subtypes)');
    await messageSubscribe(env, 'project.task', [taskId], [task.partner_id], null);
  }
  const parent = await flatParent(env, taskId);
  const [mid] = await insertMessages(env, [{
    model: 'project.task', res_id: taskId, body: bodies.message, author_id: authorId, email_from: emailFrom, message_type: 'auto_comment',
    subtype_id: note, subject, reply_to: await replyToDefault(env, emailFrom), message_id: trackingMessageId(`${taskId}-project.task`),
    email_add_signature: false, record_company_id: company, email_layout_xmlid: 'mail.mail_notification_light',
    ...(parent !== null ? { parent_id: parent } : {}), ...(task.partner_id !== null ? { partner_ids: [task.partner_id] } : {}),
  }]);
  await env.cr.query('UPDATE mail_message SET reply_to_force_new = false WHERE id = $1', [mid]);
  if (task.partner_id !== null) await notify(env, taskId, mid!, { light: true });
}

/** mail_thread.py:3173-3196 `_message_compute_parent_id`: project.task is a flat thread. */
async function flatParent(env: Environment, taskId: number): Promise<number | null> {
  const rows = (await env.cr.query<{ id: number; message_type: string; d: string }>(
    `SELECT id, message_type, COALESCE(date, create_date)::text AS d FROM mail_message
      WHERE res_id = $1 AND model = 'project.task' AND message_type != 'user_notification' ORDER BY date DESC, id DESC LIMIT 200`, [taskId])).rows;
  const key = (m: { id: number; message_type: string; d: string }): [number, string, number] => [['comment', 'email'].includes(m.message_type) ? 1 : 0, m.d, m.id];
  rows.sort((a, b) => {
    const ka = key(a), kb = key(b);
    for (let i = 0; i < 3; i++) if (ka[i] !== kb[i]) return ka[i]! < kb[i]! ? 1 : -1;
    return 0;
  });
  return rows[0]?.id ?? null;
}

async function notify(env: Environment, taskId: number, messageId: number, opts: { light?: boolean }): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('task notification outside a request');
  await (await notifyThread(ctx, env, 'project.task', taskId, messageId, opts)).send();
}

/** project_task.py:1658-1673 `_track_log_get_default_subtype`. */
const STATE_SUBTYPES: Readonly<Record<string, string>> = {
  '1_done': 'project.mt_task_done', '1_canceled': 'project.mt_task_canceled', '01_in_progress': 'project.mt_task_in_progress',
  '03_approved': 'project.mt_task_approved', '02_changes_requested': 'project.mt_task_changes_requested', '04_waiting_normal': 'project.mt_task_waiting',
};

/**
 * mail_track_mixin.py:133-198 `_track_finalize` with mail_thread.py:550-566 `_track_execute`, when the outermost write
 * returns: a tracking message per task (with the stage or state subtype: a `message_post`, notifying that subtype's
 * followers), then the stage's mail template (`_track_post_template`).
 */
export async function taskTrackFinalize(env: Environment): Promise<void> {
  const collected = await trackCollect(env, 'project.task');
  if (!collected || !collected.changes.size) return;
  const logs = new Map<number, string>();
  const senv = collected.env.sudo();
  for (const [id, c] of collected.changes) {
    let subtype: string | undefined;
    if (c.changes.includes('stage_id')) subtype = 'project.mt_task_stage';
    else if (c.changes.includes('state')) {
      subtype = STATE_SUBTYPES[(await senv.cr.query<{ state: string }>('SELECT state FROM project_task WHERE id = $1', [id])).rows[0]?.state ?? ''];
    }
    if (subtype === undefined) { logs.set(id, c.body); continue; }
    const [authorId, emailFrom] = await computeAuthor(senv, (await userInfo(env)).partnerId, null);
    const parent = await flatParent(senv, id);
    const [mid] = await insertMessages(senv, [{
      model: 'project.task', res_id: id, body: c.body, author_id: authorId, email_from: emailFrom, message_type: 'tracking',
      subtype_id: await xmlid(senv, subtype), reply_to: await replyToDefault(senv, emailFrom), message_id: trackingMessageId(`${id}-project.task`),
      email_add_signature: true, ...(parent !== null ? { parent_id: parent } : {}),
      record_company_id: (await senv.cr.query<{ c: number | null }>('SELECT company_id AS c FROM project_task WHERE id = $1', [id])).rows[0]?.c ?? await senv.company(),
    }]);
    await notify(senv, id, mid!, {});
  }
  if (logs.size) await messageLogBatch(collected.env, 'project.task', logs, { messageType: 'tracking' });
  for (const [id, c] of collected.changes) if (c.changes.includes('stage_id')) await postStageTemplate(collected.env, id);
}
