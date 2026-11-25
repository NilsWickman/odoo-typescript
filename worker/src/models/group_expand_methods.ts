/**
 * The models' own `group_expand` methods of poc_erp that no other file ports (gen/out/poc_erp/group_expand.json lists
 * every field with one; src/web/read_group.ts applies the generic `_read_group_expand_full` and a selection's
 * `_default_group_expand` from that file and refuses a method nobody registered). They decide the empty groups a
 * kanban or a grouped list shows (models.py:1148 `_web_read_group_expand`).
 */
import { NotPorted } from "../errors";
import { cond, or, TRUE } from "../orm/domain";
import { registerGroupExpand } from "../web/read_group";

// product_template.py:40-44 `_read_group_categ_id`: the context's default category, else every category with
// `group_expand` in the context (sudo, the comodel's order), else none
registerGroupExpand("product.template", "categ_id", async (env) => {
  const dflt = env.context["default_categ_id"];
  if (dflt) {
    if (typeof dflt === "number") return [dflt];
    if (Array.isArray(dflt) && dflt.every((x) => typeof x === "number")) return dflt;
    throw new NotPorted(`product.template categ_id group_expand with default_categ_id ${JSON.stringify(dflt)}`);
  }
  if (env.context["group_expand"]) return env.sudo().model("product.category").search(TRUE);
  return [];
});

// stock_lot.py:38-40 `_read_group_location_id`: the customer and supplier locations, then every warehouse's stock
// location (`warehouse_id.search([]).lot_stock_id`, in the warehouses' order, each once)
registerGroupExpand("stock.lot", "location_id", async (env) => {
  const partner = await env.model("stock.location").search(cond("usage", "in", ["customer", "supplier"]));
  const warehouses = await env.model("stock.warehouse").search(TRUE);
  const stock: number[] = [];
  for (const w of warehouses.length ? await env.model("stock.warehouse").read(warehouses, ["lot_stock_id"]) : []) {
    const l = w["lot_stock_id"];
    const id = Array.isArray(l) ? l[0] : l;
    if (typeof id === "number" && !stock.includes(id)) stock.push(id);
  }
  return [...partner, ...stock];
});

// sale_project project_task.py:62-74 `_group_expand_sales_order`: the groups as they are, unless a gantt view asks
registerGroupExpand("project.task", "sale_order_id", async (env, _model, values) => {
  if (env.context["gantt_start_date"] && env.context["gantt_scale"]) throw new NotPorted("project.task sale_order_id group_expand in a gantt view");
  return [...values];
});

// project_task.py:150-151 `_read_group_personal_stage_type_ids` on personal_stage_id too (:217-220 names the same
// method): `stages` are then project.task.stage.personal records, searched on their own user_id
registerGroupExpand("project.task", "personal_stage_id", async (env, _model, values) =>
  env.model("project.task.stage.personal").search(or([cond("id", "in", [...values]), cond("user_id", "=", env.uid)])));

// utm_campaign.py:56-61 `_group_expand_stage_ids`: every stage (sudo, the comodel's order)
registerGroupExpand("utm.campaign", "stage_id", async (env) => env.sudo().model("utm.stage").search(TRUE));
