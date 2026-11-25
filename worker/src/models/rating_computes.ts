/**
 * rating.rating references, their selection and the access token default (odoo/addons/rating/models/rating.py).
 */
import { randomUUID } from "node:crypto";
import { registerHooks } from "../orm/hooks";
import { registerDefaults, registerRecordCompute } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { defineComputes, referenceIfExists } from "./tail_util";

/** rating.py:21-23 _selection_target_model: every ir.model (mail/models/ir_model.py:10 `_order`). */
async function targetModels(env: Environment): Promise<readonly [string, string][]> {
  const lang = env.lang ?? "en_US";
  const rows = await env.cr.query<{ model: string; name: string }>(
    `SELECT model, COALESCE(name->>$1, name->>'en_US') AS name FROM ir_model
     ORDER BY is_mail_thread DESC, COALESCE(name->>$1, name->>'en_US') ASC`, [lang]);
  return rows.rows.map((r) => [r.model, r.name] as [string, string]);
}
registerHooks("rating.rating", { selection: { resource_ref: targetModels, parent_ref: targetModels } });

/** rating.py:74-80 / :82-88: `'%s,%s' % (model, id or 0)` when the model is in the registry, through convert_to_cache. */
function reference(modelField: string, idField: string) {
  return async (env: Environment, rec: { get(name: string): Promise<unknown> }): Promise<string | null> => {
    const model = await rec.get(modelField);
    if (typeof model !== "string" || !model || !env.reg.models.has(model)) return null;
    const id = await rec.get(idField);
    return referenceIfExists(env, model, typeof id === "number" ? id : 0);
  };
}
defineComputes("rating.rating", {
  resource_ref: reference("res_model", "res_id"),
  parent_ref: reference("parent_res_model", "parent_res_id"),
});

registerDefaults("rating.rating", {
  // rating.py:17-19 _default_access_token: uuid.uuid4().hex
  access_token: async () => randomUUID().replace(/-/g, ""),
});

registerRecordCompute("rating.rating", {
  // rating.py:63-70 _compute_res_name (stored): the record's display name as superuser, else "<model>/<id>"
  res_name: async (env, rec) => {
    const model = await rec.get("res_model"), id = await rec.get("res_id");
    let name: unknown = false;
    if (typeof model === "string" && model && typeof id === "number" && id) {
      if (!env.reg.models.has(model)) throw new Error(`KeyError: '${model}'`);
      name = (await env.sudo().model(model).displayName([id])).get(id) ?? false;
    }
    // f'{rating.res_model}/{rating.res_id}' prints Python's False/None/int
    const py = (v: unknown): string => (v === null || v === undefined || v === false ? "False" : String(v));
    return name || `${py(model)}/${typeof id === "number" ? id : 0}`;
  },
});

registerRecordCompute("rating.rating", {
  // rating.py:89-96 _compute_parent_res_name (stored)
  parent_res_name: async (env, rec) => {
    const model = await rec.get("parent_res_model"), id = await rec.get("parent_res_id");
    if (!(typeof model === "string" && model && typeof id === "number" && id)) return false;
    if (!env.reg.models.has(model)) throw new Error(`KeyError: '${model}'`);
    const name = (await env.sudo().model(model).displayName([id])).get(id) ?? false;
    return name || `${model}/${id}`;
  },
});

registerRecordCompute("rating.rating", {
  // rating.py:115-118 _compute_rating_text with rating_data.py:54-75 _rating_to_text
  rating_text: async (_env, rec) => {
    const value = Number((await rec.get("rating")) ?? 0);
    if (!(value >= 0 && value <= 5)) throw new Error("AssertionError");
    if (value >= 4) return "top";
    if (value >= 3) return "ok";
    if (value >= 1) return "ko";
    return "none";
  },
});

/** rating_mixin.py:28-49 `_compute_rating_last_value`: the latest consumed rating (write_date desc, id desc), else 0. */
for (const model of ["project.task"]) {
  defineComputes(model, {
    rating_last_value: async (env, rec) => {
      if (rec.id === null) return 0;
      const row = (await env.cr.query<{ rating: number | null }>(
        `SELECT rating FROM rating_rating WHERE res_model = $1 AND res_id = $2 AND consumed = true
          ORDER BY write_date DESC, id DESC LIMIT 1`, [model, rec.id])).rows[0];
      return row?.rating ?? 0;
    },
  });
}

/**
 * rating_mixin.py:99-111 `write` of a rated record (project.task: `_rec_name` name, `_rating_get_parent_field_name`
 * project_id, project_task.py:2220): after the write, a new name recomputes the stored `res_name` of its ratings
 * (rating.py:65-71, the record's display name as superuser), a new parent is written on them (`parent_res_id`).
 */
registerHooks("project.task", {
  write: [{
    afterWrite: async (env, ids, vals) => {
      if (!("name" in vals) && !("project_id" in vals)) return;
      const su = env.sudo();
      const ratings = (await env.cr.query<{ id: number; res_id: number }>(
        "SELECT id, res_id FROM rating_rating WHERE res_model = 'project.task' AND res_id = ANY($1::int[]) ORDER BY id", [[...ids]])).rows;
      if (!ratings.length) return;
      const tasks = [...new Set(ratings.map((r) => r.res_id))];
      if ("name" in vals) {
        const names = await su.model("project.task").displayName(tasks);
        // the recompute is flushed as a write of the ratings (measured: write_uid and write_date follow, proofs/scenarios/r12_guard.py)
        for (const r of ratings) {
          await env.cr.query("UPDATE rating_rating SET res_name = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1",
            [r.id, names.get(r.res_id) || `project.task/${r.res_id}`, env.uid]);
        }
      }
      if ("project_id" in vals) {
        const { write } = await import("../orm/write");
        const rows = (await env.cr.query<{ id: number; project_id: number | null }>("SELECT id, project_id FROM project_task WHERE id = ANY($1::int[]) ORDER BY id", [tasks])).rows;
        for (const t of rows) await write(su, "rating.rating", ratings.filter((r) => r.res_id === t.id).map((r) => r.id), { parent_res_id: t.project_id ?? false });
      }
    },
  }],
});
