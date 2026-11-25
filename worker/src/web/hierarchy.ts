/**
 * `hierarchy_read` (odoo/addons/web_hierarchy/models/models.py:9-46): the records of the hierarchy view, with the
 * parent of a single root and its siblings, and `__child_ids__` from a read_group when no child field is given.
 */
import { NotPorted } from "../errors";
import { and, cond, parseDomain } from "../orm/domain";
import { envFor, isRecord, parseSpecification } from "./common";
import { rawReadGroup } from "./read_group";
import { webRead } from "./read";
import { registerBaseMethod } from "./register";

registerBaseMethod("hierarchy_read", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const domain = parseDomain(kwargs["domain"] ?? args[0]);
  const rawSpec = kwargs["specification"] ?? args[1];
  const parentField = kwargs["parent_field"] ?? args[2];
  const childField = kwargs["child_field"] ?? args[3] ?? null;
  const orderRaw = kwargs["order"] ?? args[4] ?? null;
  if (typeof parentField !== "string" || !isRecord(rawSpec)) throw new NotPorted("hierarchy_read arguments");
  const order = typeof orderRaw === "string" && orderRaw !== "" ? orderRaw : null;
  const specObj: Record<string, unknown> = { ...rawSpec };
  if (!(parentField in specObj)) specObj[parentField] = { fields: { display_name: {} } };
  const Model = env.model(model);
  let records = await Model.search(domain, { order });
  let fetchAll = false;
  if (!records.length) return [];
  if (records.length === 1) {
    const id = records[0]!;
    const parent = (await Model.read([id], [parentField], ""))[0]?.[parentField];
    let d = and([cond(parentField, "=", id), cond("id", "!=", id)]);
    if (typeof parent === "number") {
      records = [...records, parent];
      d = and([cond("id", "not in", records), cond(parentField, "in", records)]);
    }
    records = [...records, ...(await Model.search(d, { order }))];
  } else {
    fetchAll = true;
  }
  const children = new Map<number, unknown>();
  if (!childField) {
    let targets = records;
    if (!fetchAll) {
      const parents = new Set((await Model.read(records, [parentField], "")).map((r) => r[parentField]).filter((v): v is number => typeof v === "number"));
      targets = records.filter((r) => !parents.has(r));
    }
    for (const row of await rawReadGroup(env, model, cond(parentField, "in", targets), [parentField], ["id:array_agg"], { order })) {
      if (typeof row[0] === "number") children.set(row[0], row[1]);
    }
  }
  const result = await webRead(env, model, [...new Set(records)], parseSpecification(specObj, "specification"));
  for (const r of result) if (children.has(Number(r["id"]))) r["__child_ids__"] = children.get(Number(r["id"]));
  return result;
}, { apiModel: true, readonly: true });
