/**
 * Two configuration writes with side effects (rådet runda 12, `opus12_writes`): an archived task stage archives its
 * tasks (project_task_type.py:109-121), and the variant mode of an attribute used on products cannot change
 * (product_attribute.py:108-125, UserError). The task stage's rating switch (`rating_active`) shows or hides the
 * rating subtypes (rådet runda 13).
 */
import { UserError } from "../errors";
import { registerOverrides, write } from "../orm/write";
import { cond } from "../orm/domain";
import { translate } from "./util";

registerOverrides("project.task.type", {
  write: async (env, ids, vals, next) => {
    // :110-111 the active tasks of the stages (`search` with the active filter) are archived first
    if ("active" in vals && !vals["active"]) {
      const found = (await env.cr.query<{ id: number }>("SELECT id FROM project_task WHERE stage_id = ANY($1::int[]) AND active ORDER BY id", [[...ids]])).rows.map((r) => r.id);
      if (found.length) await write(env, "project.task", found, { active: false });
    }
    // :112-120 the first stage with ratings shows the rating subtypes, the last one without hides them (rådet runda 13)
    if ("rating_active" in vals) {
      const ratingActive = Boolean(vals["rating_active"]);
      const withRating = await env.model("project.task.type").search(cond("rating_active", "=", true));
      if ((!withRating.length && ratingActive) || (withRating.length && withRating.every((id) => ids.includes(id)) && !ratingActive)) {
        const { xmlid } = await import("../mail/message");
        const projectRating = await xmlid(env, "project.mt_project_task_rating");
        await write(env, "mail.message.subtype", [projectRating], { hidden: !ratingActive });
        await write(env, "mail.message.subtype", [projectRating], { default: ratingActive });
        await write(env, "mail.message.subtype", [await xmlid(env, "project.mt_task_rating")], { hidden: !ratingActive });
      }
    }
    await next(env, ids, vals);
  },
});

registerOverrides("product.attribute", {
  write: async (env, ids, vals, next) => {
    if ("create_variant" in vals) {
      for (const id of ids) {
        const [a] = (await env.cr.query<{ cv: string | null }>("SELECT create_variant AS cv FROM product_attribute WHERE id = $1", [id])).rows;
        // :74-84 number_related_products: the active lines of active templates
        const [n] = (await env.cr.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM product_template_attribute_line l JOIN product_template t ON t.id = l.product_tmpl_id
            WHERE l.attribute_id = $1 AND l.active AND t.active`, [id])).rows;
        if (vals["create_variant"] === (a?.cv ?? false) || !n?.n) continue;
        const name = (await env.model("product.attribute").displayName([id])).get(id) ?? "";
        // `pa.product_tmpl_ids` (stored, in the template's order) and their display names
        const [rec] = await env.withContext({ ...env.context, active_test: false }).model("product.attribute").read([id], ["product_tmpl_ids"], "");
        const tmpls = (rec?.["product_tmpl_ids"] as number[] | undefined) ?? [];
        const names = await env.model("product.template").displayName(tmpls);
        throw new UserError(translate(env, "You cannot change the Variants Creation Mode of the attribute %(attribute)s because it is used on the following products:\n%(products)s", "product")
          .replace("%(attribute)s", name).replace("%(products)s", tmpls.map((t) => names.get(t) ?? "").join(", ")));
      }
    }
    await next(env, ids, vals);
  },
});
