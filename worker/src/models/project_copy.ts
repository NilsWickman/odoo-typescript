/**
 * Duplicating a project (odoo/addons/project/models/project_project.py):
 *  - `copy_data` (:531-551, over mail_alias_mixin_optional's and BaseModel's, src/web/save.ts): "<name> (copy)" in
 *    each stored language (`mark_as_copy('name')`, translate.py:954-976), a template stays a template;
 *  - `copy` (:553-581): the copy created with mail_auto_subscribe_no_notify and mail_create_nosubscribe (no
 *    default_stage_id), then with a fresh `milestone_mapping` the old project's followers subscribed with their subtypes
 *    (`message_subscribe`, :821-837: the new project has no tasks or updates yet), its milestones copied onto the new
 *    project (:123-130 mapping old to new), its tasks copied (`map_tasks`, :513-529, src/models/task_copy.ts) and the
 *    subtasks of the copies moved to the new project.
 * Template copies (`copy_from_template`), archived projects, a default with `tasks`, and shared embedded actions or
 * their user configurations (:583-640) refuse.
 */
import { NotPorted } from "../errors";
import * as D from "../orm/domain";
import { hasGroup } from "../orm/env";
import { registerMethod } from "../http/methods";
import { messageSubscribe } from "../mail/followers";
import { registerOverrides, write } from "../orm/write";
import { writeColumns } from "../orm/recompute";
import { CopiedTranslations, copy, markAsCopyTranslations } from "../web/save";
import { envFor } from "../web/common";
import type { Environment } from "../orm/types";
import { copyTasks } from "./task_copy";

/** The mutable `milestone_mapping` of the context (old milestone id -> new), shared by reference as Odoo's dict. */
export type MilestoneMapping = Map<number, number>;

registerOverrides("project.project", {
  copyData: async (env, ids, valsList, given) => {
    const copyFromTemplate = Boolean(env.context["copy_from_template"]);
    const hasProjectStageFeature = copyFromTemplate && !("stage_id" in given) && await hasGroup(env, "project.group_project_stages");
    const rows = (await env.cr.query<{ id: number; is_template: boolean | null; stage_id: number | null; name: Record<string, unknown> | null }>(
      "SELECT id, is_template, stage_id, name FROM project_project WHERE id = ANY($1::int[])", [[...ids]])).rows;
    for (let i = 0; i < ids.length; i++) {
      const project = rows.find((r) => r.id === ids[i])!;
      const vals = valsList[i]!;
      if (project.is_template && !copyFromTemplate) vals["is_template"] = true; // :539-540
      if (copyFromTemplate) {
        if (hasProjectStageFeature) vals["stage_id"] = project.stage_id ?? false; // :542-543
        // _get_template_field_blacklist (:1383-1389): ["partner_id"]
        for (const field of ["partner_id"]) {
          if (field in vals && !(field in given)) delete vals[field];
        }
      }
      // :547-550 `mark_as_copy('name')(project)` unless the default names it, copying from template, or converting to template
      if (!("name" in given) && !(copyFromTemplate || (!project.is_template && vals["is_template"]))) {
        const stored = vals["name"];
        if (!(stored instanceof CopiedTranslations)) throw new NotPorted("project.project copy of a name without stored translations");
        vals["name"] = new CopiedTranslations(await markAsCopyTranslations(env, stored.values));
      }
    }
  },
});

/** The shared embedded actions and the users' embedded action configurations of the projects (:583-640). */
async function refuseEmbeddedActions(env: Environment, ids: readonly number[]): Promise<void> {
  const shared = await env.cr.query("SELECT 1 FROM ir_embedded_actions WHERE parent_res_model = 'project.project' AND parent_res_id = ANY($1::int[]) AND user_id IS NULL LIMIT 1", [[...ids]]);
  if (shared.rows.length) throw new NotPorted("project.project copy with shared embedded actions (_copy_shared_embedded_actions)");
  const configs = await env.cr.query("SELECT 1 FROM res_users_settings_embedded_action WHERE res_model = 'project.project' AND res_id = ANY($1::int[]) LIMIT 1", [[...ids]]);
  if (configs.rows.length) throw new NotPorted("project.project copy with embedded action configurations (_copy_embedded_actions_config)");
}

export async function copyProjects(env: Environment, ids: readonly number[], dflt: Record<string, unknown>): Promise<number[]> {
  const given: Record<string, unknown> = { ...dflt };
  if ("tasks" in given) throw new NotPorted("project.project copy with tasks in the default");
  const inactive = await env.cr.query("SELECT 1 FROM project_project WHERE id = ANY($1::int[]) AND active IS NOT TRUE", [[...ids]]);
  if (inactive.rows.length) throw new NotPorted("project.project copy of an archived project (tasks reactivated)");
  await refuseEmbeddedActions(env, ids);
  given["milestone_ids"] = false; // :555-556
  const { default_stage_id: _drop, ...rest } = env.context; // :561
  const copyEnv = env.withContext({ ...rest, mail_auto_subscribe_no_notify: true, mail_create_nosubscribe: true });
  const created = await copy(copyEnv, "project.project", ids, given, true);
  // :563-564 a fresh mapping unless the caller gave one
  const mapping: MilestoneMapping = env.context["milestone_mapping"] instanceof Map ? env.context["milestone_mapping"] as MilestoneMapping : new Map();
  if (env.context["milestone_mapping"] !== undefined && !(env.context["milestone_mapping"] instanceof Map)) throw new NotPorted("project.project copy with a milestone_mapping from the caller");
  const self = env.withContext({ ...env.context, milestone_mapping: mapping });
  for (let i = 0; i < ids.length; i++) {
    const oldId = ids[i]!, newId = created[i]!;
    // :566-567 the followers (mail.followers `_order` id) with their subtypes (mail.message.subtype `_order` sequence, id)
    const followers = (await self.cr.query<{ id: number; partner_id: number | null }>(
      "SELECT id, partner_id FROM mail_followers WHERE res_model = 'project.project' AND res_id = $1 ORDER BY id", [oldId])).rows;
    for (const f of followers) {
      if (f.partner_id === null) throw new NotPorted("project.project copy of a follower without partner");
      const subtypes = (await self.cr.query<{ id: number }>(
        `SELECT s.id FROM mail_followers_mail_message_subtype_rel r JOIN mail_message_subtype s ON s.id = r.mail_message_subtype_id
          WHERE r.mail_followers_id = $1 ORDER BY s.sequence, s.id`, [f.id])).rows.map((r) => r.id);
      // :821-837 project's message_subscribe: the new project has no tasks and no updates yet
      await messageSubscribe(self, "project.project", [newId], [f.partner_id], subtypes);
    }
    const project = (await self.cr.query<{ allow_milestones: boolean | null }>("SELECT allow_milestones FROM project_project WHERE id = $1", [oldId])).rows[0]!;
    if (project.allow_milestones) {
      // :569-570 `new_project.milestone_ids = old_project.milestone_ids.copy().ids` (milestone `_order`)
      const milestones = await self.model("project.milestone").search(D.cond("project_id", "=", oldId), { activeTest: false });
      const copies = milestones.length ? await copyMilestones(self, milestones) : [];
      await write(self, "project.project", [newId], { milestone_ids: [[6, 0, copies]] });
    }
    await mapTasks(self, oldId, newId); // :571-572
  }
  return created;
}

registerMethod("project.project", "copy", async (env0, ids0, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt))) throw new NotPorted("copy default");
  return copyProjects(env, ids0 ?? [], (dflt && typeof dflt === "object" ? dflt : {}) as Record<string, unknown>);
}, { apiModel: false });

/** project_milestone.py:123-130 `copy`: the generic copy, then old -> new in the context's `milestone_mapping`. */
async function copyMilestones(env: Environment, ids: readonly number[]): Promise<number[]> {
  const created = await copy(env, "project.milestone", ids, {});
  const mapping = env.context["milestone_mapping"];
  if (mapping instanceof Map) {
    for (let i = 0; i < ids.length; i++) {
      const allow = (await env.cr.query<{ a: boolean | null }>(
        "SELECT p.allow_milestones AS a FROM project_milestone m JOIN project_project p ON p.id = m.project_id WHERE m.id = $1", [ids[i]])).rows[0]?.a;
      if (allow) mapping.set(ids[i]!, created[i]!);
    }
  }
  return created;
}

registerMethod("project.milestone", "copy", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && (typeof dflt !== "object" || Array.isArray(dflt) || Object.keys(dflt).length)) throw new NotPorted("project.milestone copy with a default");
  if (env.context["milestone_mapping"] !== undefined) throw new NotPorted("project.milestone copy with a milestone_mapping from the caller");
  return copy(env, "project.milestone", ids ?? [], {}, true);
}, { apiModel: false });

/**
 * project_project.py:513-529 `map_tasks`: the project's top-level tasks (archived included, task `_order`) copied with
 * `copy_project` and the defaults of `_map_tasks_default_values` (:503-511), then the subtasks of the copies that are
 * still in the old project moved to the new one.
 */
async function mapTasks(env: Environment, oldId: number, newId: number): Promise<void> {
  const tasks = await env.model("project.task").search(D.and([D.cond("project_id", "=", oldId), D.cond("parent_id", "=", false)]), { activeTest: false });
  const company = (await env.cr.query<{ company_id: number | null }>("SELECT company_id FROM project_project WHERE id = $1", [newId])).rows[0]!.company_id;
  const defaults = { state: "01_in_progress", company_id: company ?? false, project_id: newId };
  const copies = tasks.length ? await copyTasks(env.withContext({ ...env.context, active_test: false, copy_project: true }), tasks, defaults) : [];
  if (!copies.length) return;
  // `_get_all_subtasks` (project_task.py:1836-1870): the descendants of the copies
  const subtasks = (await env.cr.query<{ id: number }>(
    `WITH RECURSIVE tree AS (SELECT id FROM project_task WHERE parent_id = ANY($1::int[])
       UNION SELECT t.id FROM project_task t JOIN tree ON t.parent_id = tree.id)
     SELECT t.id FROM tree JOIN project_task t ON t.id = tree.id WHERE t.project_id = $2 ORDER BY t.id`, [copies, oldId])).rows.map((r) => r.id);
  if (!subtasks.length) return;
  await write(env, "project.task", subtasks, { project_id: newId });
  // Measured in an Odoo shell (a copied project with a subtask): the subtask copies' `_compute_duration_tracking`
  // (mail_tracking_duration_mixin.py:25-57) is still pending when this write marks it again, so Odoo computes it once,
  // after the move: {s, d}. The port computed it at create and again after the stage recompute, which adds the
  // current stage with 0 minutes; that second step is undone for these copies.
  const def = env.reg.model("project.task");
  const rows = (await env.cr.query<{ id: number; dt: Record<string, unknown> | null }>(
    "SELECT id, duration_tracking AS dt FROM project_task WHERE id = ANY($1::int[]) ORDER BY id", [subtasks])).rows;
  const fixed: [number, Record<string, unknown>][] = [];
  for (const r of rows) {
    const dt = r.dt ?? {};
    const extra = Object.keys(dt).filter((k) => k !== "s" && k !== "d");
    if (extra.length === 1 && extra[0] === String(dt["s"]) && dt[extra[0]!] === 0) fixed.push([r.id, { duration_tracking: { s: dt["s"], d: dt["d"] } }]);
    else if (extra.length) throw new NotPorted("project.task copy: duration_tracking of a moved subtask copy with time in other stages");
  }
  if (fixed.length) await writeColumns(env, def, fixed, false, true);
}
