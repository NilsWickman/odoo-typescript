/**
 * project_task.py:699-704 `_compute_company_id` (stored, `@api.depends('project_id.company_id', 'parent_id.company_id')`):
 * a task with a project or a parent takes the project's company, else the parent's; a task with neither keeps its
 * company. Recomputed on existing tasks when their project changes (the subtasks a project copy moves,
 * project_project.py:524-528); the other computes that follow the project are src/models/project_task_create.ts.
 * A new record of an onchange (the task form, a sub-task line whose parent is the unsaved form) computes the same
 * way from its form values; without a project or parent it keeps its cached value (the default,
 * project_computes.ts `_default_company_id`). The create path never computes it: the default is always in the values.
 */
import { NotPorted } from "../errors";
import { NewRec, NOT_ASSIGNED, registerRecordCompute, type Rec } from "../orm/recompute";

/** `record.company_id` of a project or a parent task as an id: a new company is refused. */
async function companyOf(rec: Rec | null): Promise<number | null> {
  const company = rec ? await rec.rel("company_id") : null;
  if (company instanceof NewRec) throw new NotPorted("project.task company_id of a new company");
  return company ? company.id : null;
}

registerRecordCompute("project.task", {
  company_id: async (_env, rec) => {
    const project = await rec.rel("project_id");
    const parent = await rec.rel("parent_id");
    if (!parent && !project) return rec.id === null ? rec.prev("company_id") : NOT_ASSIGNED;
    return (await companyOf(project)) ?? (await companyOf(parent));
  },
});
