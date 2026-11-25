/**
 * Duplicating a task: project_task.py:866-942 `copy_data` and :993-1010 `copy` (the generic copy is src/web/save.ts).
 * copy_data: the dependencies emptied (default), the fields the user cannot read dropped (`has_field_access`), the
 * stage kept, an archived task reactivated (not in a project copy), the name "<name> (copy)" (as is in a project copy,
 * `copy_project`), the milestone through the context's `milestone_mapping`, the active subtasks as nested creates of
 * their own copy_data (with the default reduced to `parent_id=False`), the active assignees only; copy: created with
 * mail_auto_subscribe_no_notify, mail_create_nosubscribe and mail_create_nolog, the dependencies between copied tasks
 * mapped onto the copies (`_resolve_copied_dependencies` :944-991), then "Task Created" logged on each copy.
 * Recurrences, archived subtasks (the mapping of :944-972 pairs them with the active ones' copies) and the template
 * contexts refuse.
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { messageLogBatch, plaintextBody } from "../mail/message";
import * as D from "../orm/domain";
import { hasFieldAccess } from "../orm/sql";
import { withDbErrors } from "../orm/sql_errors";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { copy, copyData } from "../web/save";
import { envFor } from "../web/common";
import { withPrecommit } from "./precommit";

const RECURRENCE_FIELDS = ["repeat_interval", "repeat_unit", "repeat_type", "repeat_until"];
const TASK_TEMPLATE_WHITELIST = new Set(["parent_id", "project_id", "sale_line_id", "from_sale_order_action"]);

/** `task.child_ids` (task `_order`, the field's domain, :250), archived ones only when the context's active_test is False. */
async function childIds(env: Environment, taskId: number): Promise<number[]> {
  return env.model("project.task").search(D.and([
    D.cond("parent_id", "=", taskId), D.cond("recurring_task", "=", false),
    D.or([D.cond("parent_id.is_template", "=", true), D.cond("is_template", "=", false)]),
  ]), { activeTest: env.context["active_test"] !== false });
}

async function taskTemplateBlacklist(env: Environment): Promise<string[]> {
  const fields = ["partner_id"];
  const pid = env.context["default_project_id"];
  if (typeof pid === "number") {
    const allow = (await env.cr.query<{ a: boolean | null }>("SELECT allow_recurring_tasks AS a FROM project_project WHERE id = $1", [pid])).rows[0]?.a;
    if (!allow) fields.push(...RECURRENCE_FIELDS, "recurrence_id", "recurring_task");
  }
  return fields;
}

registerOverrides("project.task", {
  // :867-871 `default.update(depend_on_ids=False, dependent_ids=False)` before super()
  copyDefaults: (defaults) => ({ ...defaults, depend_on_ids: false, dependent_ids: false }),
  copyData: async (env, ids, valsList, given) => {
    if (env.context["convert_to_template"]) throw new NotPorted("project.task copy with convert_to_template in the context");
    if ("child_ids" in given) throw new NotPorted("project.task copy with child_ids in the default");
    const copyProject = Boolean(env.context["copy_project"]);
    const copyFromTemplate = Boolean(env.context["copy_from_template"]);
    const projectTemplate = typeof env.context["copy_from_project_template"] === "number" ? env.context["copy_from_project_template"] as number : 0;
    const roleMappingRaw = env.context["role_to_users_mapping"];
    const roleMapping = roleMappingRaw && typeof roleMappingRaw === "object" && !Array.isArray(roleMappingRaw)
      ? (roleMappingRaw instanceof Map ? roleMappingRaw as Map<number, number[]> : new Map(Object.entries(roleMappingRaw as Record<string, number[]>).map(([k, v]) => [Number(k), v])))
      : undefined;
    const mapping = env.context["milestone_mapping"];
    if (mapping !== undefined && !(mapping instanceof Map)) throw new NotPorted("project.task copy with a milestone_mapping that is not the project copy's");
    // `default` of :867-871, which the subtask branch (:907-909) replaces for the following tasks
    let dflt: Record<string, unknown> = { ...given, depend_on_ids: false, dependent_ids: false };
    const hasDefaultUsers = "user_ids" in given;
    const def = env.reg.model("project.task");
    const blacklist = copyFromTemplate ? await taskTemplateBlacklist(env) : [];
    const rows = (await env.cr.query<{ id: number; stage_id: number | null; active: boolean | null; name: string | null; recurrence_id: number | null;
      allow_milestones: boolean | null; is_template: boolean | null; project_id: number | null }>(
      `SELECT t.id, t.stage_id, t.active, t.name, t.recurrence_id, p.allow_milestones, t.is_template, t.project_id
         FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id WHERE t.id = ANY($1::int[])`, [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const task = rows.find((r) => r.id === ids[i])!;
      const vals = valsList[i]!;
      // :875-883 only the fields the user may read
      for (const k of Object.keys(vals)) {
        const f = def.fields.get(k);
        if (f && !(await hasFieldAccess(env, f))) delete vals[k];
      }
      if (!dflt["stage_id"]) vals["stage_id"] = task.stage_id ?? false; // :894-895
      if (!("active" in dflt) && !task.active && !copyProject) vals["active"] = true; // :896-897
      // :898-899 the name as is in a project copy or template copy, else `_("%s (copy)", task.name)`
      if (!dflt["name"]) {
        if (copyProject || copyFromTemplate) vals["name"] = task.name ?? false;
        else {
          if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated "(copy)" suffix (${env.lang})`);
          vals["name"] = `${task.name ?? ""} (copy)`;
        }
      }
      if (task.recurrence_id && !("recurrence_id" in dflt)) throw new NotPorted("project.task copy of a recurrent task (recurrence copy)");
      // :902-903 `milestone_mapping.get(vals['milestone_id'], vals['milestone_id'])` (the related allow_milestones)
      if (task.allow_milestones && mapping instanceof Map) {
        const m = vals["milestone_id"];
        if (typeof m === "number" && mapping.has(m)) vals["milestone_id"] = mapping.get(m);
      }
      // :904-912 the active subtasks, each `Command.create(child.copy_data(default)[0])`
      const children = await childIds(copyFromTemplate ? env.withContext({ ...env.context, active_test: true }) : env, task.id);
      if (!dflt["child_ids"] && children.length) {
        const nextDflt: Record<string, unknown> = { parent_id: false };
        if (copyFromTemplate) {
          for (const [k, v] of Object.entries(dflt)) if (TASK_TEMPLATE_WHITELIST.has(k)) nextDflt[k] = v;
        }
        dflt = nextDflt;
        const active = new Set((await env.cr.query<{ id: number }>("SELECT id FROM project_task WHERE id = ANY($1::int[]) AND active", [children])).rows.map((r) => r.id));
        const lines: unknown[] = [];
        for (const child of children.filter((c) => active.has(c))) lines.push([0, 0, (await copyData(env, "project.task", [child], dflt))[0]!]);
        vals["child_ids"] = lines;
      }
      // :913-915 the active assignees (`task.user_ids & active_users`, in the task's order)
      const users = vals["user_ids"] as unknown[][] | undefined;
      if (!hasDefaultUsers && users && users.length && Array.isArray(users[0]) && (users[0][2] as number[] | undefined)?.length) {
        const activeUsers = (await env.cr.query<{ id: number }>(
          `SELECT u.id FROM res_users u WHERE u.id = ANY($1::int[]) AND u.active`, [users[0][2]])).rows.map((r) => r.id);
        vals["user_ids"] = [[6, 0, (users[0][2] as number[]).filter((u) => activeUsers.includes(u))]];
      }
      // :916-941 copy_from_template handling
      if (copyFromTemplate) {
        if (!projectTemplate) vals["is_template"] = false;
        if (!task.is_template) {
          vals["role_ids"] = false;
          if (projectTemplate && task.project_id === projectTemplate) {
            const roleRows = (await env.cr.query<{ role_id: number }>(
              "SELECT project_role_id AS role_id FROM project_role_project_task_rel WHERE project_task_id = $1 ORDER BY project_role_id", [task.id])).rows;
            const mappedUsers = new Set<number>();
            if (roleMapping && roleMapping.size > 0) {
              for (const r of roleRows) for (const u of roleMapping.get(r.role_id) ?? []) mappedUsers.add(u);
            } else if (roleMappingRaw === undefined || roleMappingRaw === null) {
              // :926-933 random assignment when role_to_users_mapping is None and role has users
              for (const r of roleRows) {
                const cands = (await env.cr.query<{ user_id: number }>(
                  `SELECT r.res_users_id AS user_id FROM project_role_res_users_rel r JOIN res_users u ON u.id = r.res_users_id
                    WHERE r.project_role_id = $1 AND u.active ORDER BY r.res_users_id`, [r.role_id])).rows
                  .map((x) => x.user_id).filter((u) => !mappedUsers.has(u));
                if (cands.length === 1) mappedUsers.add(cands[0]!);
                else if (cands.length > 1) throw new NotPorted("project.task copy_from_template random role user assignment");
              }
            }
            if (mappedUsers.size) {
              const list = Array.isArray(vals["user_ids"]) ? [...(vals["user_ids"] as unknown[])] : [];
              for (const u of mappedUsers) list.push([4, u, 0]);
              vals["user_ids"] = list;
            }
          }
        }
        for (const f of blacklist) delete vals[f];
        if (!vals["project_id"] && "default_project_id" in env.context) vals["project_id"] = env.context["default_project_id"];
      }
    }
  },
});

/**
 * :944-991 `_create_task_mapping` and `_resolve_copied_dependencies`: original -> copy over the tasks and their
 * subtasks (copies' children by id), then each original's dependencies set on its copy, with the copied ones mapped.
 */
async function resolveCopiedDependencies(env: Environment, originals: readonly number[], copies: readonly number[]): Promise<void> {
  const mapping = new Map<number, number>();
  const deps: [number, number[], number[]][] = [];
  const walk = async (orig: readonly number[], copied: readonly number[]): Promise<void> => {
    for (let i = 0; i < Math.min(orig.length, copied.length); i++) {
      const o = orig[i]!, c = copied[i]!;
      mapping.set(o, c);
      const allow = (await env.cr.query<{ a: boolean | null; is_template: boolean | null }>(
        "SELECT p.allow_task_dependencies AS a, t.is_template FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id WHERE t.id = $1", [o])).rows[0]!;
      // `_compute_allow_task_dependencies` (:537-539)
      const allowed = allow.a !== null ? Boolean(allow.a) : Boolean(allow.is_template);
      const activeTest = env.context["active_test"] !== false;
      const dependOn = await env.model("project.task").search(D.cond("dependent_ids", "in", [o]), { activeTest });
      const dependent = await env.model("project.task").search(D.cond("depend_on_ids", "in", [o]), { activeTest });
      if (allowed && (dependOn.length || dependent.length)) deps.push([o, dependOn, dependent]);
      const children = await childIds(env, o);
      if (children.length) {
        const copiedChildren = (await env.cr.query<{ id: number }>("SELECT id FROM project_task WHERE parent_id = $1 ORDER BY id", [c])).rows.map((r) => r.id);
        await walk(children, copiedChildren);
      }
    }
  };
  await walk(originals, copies);
  for (const [orig, dependOn, dependent] of deps) {
    const target = mapping.get(orig)!;
    await write(env, "project.task", [target], { depend_on_ids: [[6, 0, dependOn.map((t) => mapping.get(t) ?? t)]] });
    await write(env, "project.task", [target], { dependent_ids: [[6, 0, dependent.map((t) => mapping.get(t) ?? t)]] });
  }
}

/** :993-1010 `copy` of tasks with the caller's environment `env` (the project copy's `map_tasks` uses it too). */
export async function copyTasks(env: Environment, ids: readonly number[], defaults: Record<string, unknown>): Promise<number[]> {
  // `_create_task_mapping` reads `child_ids` in the caller's environment: with active_test=False (a project copy) an
  // archived subtask is paired with the copy of the next active one (copy_data copies the active ones only)
  if (env.context["active_test"] === false) {
    const archived = await env.cr.query(
      `WITH RECURSIVE tree AS (SELECT id FROM project_task WHERE parent_id = ANY($1::int[]) AND active
         UNION SELECT t.id FROM project_task t JOIN tree ON t.parent_id = tree.id WHERE t.active)
       SELECT 1 FROM project_task t WHERE (t.parent_id = ANY($1::int[]) OR t.parent_id IN (SELECT id FROM tree)) AND t.active IS NOT TRUE LIMIT 1`, [[...ids]]);
    if (archived.rows.length) throw new NotPorted("project.task copy with archived subtasks in a project copy (_create_task_mapping pairs them with other copies)");
  }
  const copyFromTemplate = Boolean(env.context["copy_from_template"]);
  const env2 = env.withContext({
    ...env.context,
    mail_auto_subscribe_no_notify: true,
    mail_create_nosubscribe: true,
    mail_create_nolog: !copyFromTemplate,
  });
  // the stage templates of the copies are posted at precommit, after the "Task Created" logs (src/models/precommit.ts)
  return withPrecommit(env.cr, async () => {
    const created = await withDbErrors(env2, () => copy(env2, "project.task", ids, defaults));
    let resolveDeps = !copyFromTemplate;
    if (!resolveDeps && typeof defaults["project_id"] === "number") {
      const row = (await env.cr.query<{ a: boolean | null }>(
        "SELECT allow_task_dependencies AS a FROM project_project WHERE id = $1", [defaults["project_id"]])).rows[0];
      resolveDeps = Boolean(row?.a);
    }
    if (resolveDeps) await resolveCopiedDependencies(env, ids, created);
    // :1006-1008 `_message_log_batch` with the caller's environment (not when copying from template)
    if (!copyFromTemplate) {
      if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated "Task Created" (${env.lang})`);
      await messageLogBatch(env, "project.task", new Map(created.map((id) => [id, plaintextBody("Task Created")])));
    }
    return created;
  });
}

registerMethod("project.task", "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  return copyTasks(env, ids ?? [], (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>);
}, { apiModel: false });
