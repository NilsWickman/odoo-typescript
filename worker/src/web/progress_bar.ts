/**
 * `read_progress_bar` (odoo/addons/web/models/models.py:1584-1621): the kanban column progress bars, counted with
 * `formatted_read_group(domain, [group_by, progress_bar['field']], ['__count'])` so that the keys match the ones
 * the client builds from the groups (`str(adapt(group[group_by]))`: the id of a many2one `(id, name)` pair).
 */
import { NotPorted } from "../errors";
import { parseDomain } from "../orm/domain";
import { envFor, isRecord } from "./common";
import { formattedReadGroup } from "./read_group";
import { registerBaseMethod } from "./register";

/** Python `str()` of a group value for the result keys (`False` -> "False", ints as digits). */
function pyStr(v: unknown): string {
  if (v === false) return "False";
  if (v === true) return "True";
  if (v === null || v === undefined) return "None";
  if (typeof v === "number" || typeof v === "string") return String(v);
  throw new NotPorted(`read_progress_bar: str() of group value ${JSON.stringify(v)}`);
}

registerBaseMethod("read_progress_bar", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const groupBy = kwargs["group_by"] ?? args[1];
  const progressBar = kwargs["progress_bar"] ?? args[2];
  if (typeof groupBy !== "string") throw new NotPorted("read_progress_bar: group_by must be a string");
  if (!isRecord(progressBar) || typeof progressBar["field"] !== "string" || !isRecord(progressBar["colors"])) {
    throw new NotPorted("read_progress_bar: progress_bar needs field and colors");
  }
  const field = progressBar["field"];
  const colors = Object.keys(progressBar["colors"]);
  // defaultdict(lambda: dict.fromkeys(progress_bar['colors'], 0)) (:1608)
  const result: Record<string, Record<string, number>> = {};
  for (const group of await formattedReadGroup(env, model, parseDomain(kwargs["domain"] ?? args[0]), [groupBy, field], ["__count"])) {
    const fieldValue = group[field];
    if (typeof fieldValue !== "string" || !colors.includes(fieldValue)) continue;
    const raw = group[groupBy];
    const key = pyStr(Array.isArray(raw) ? raw[0] : raw); // adapt(): tuple -> value[0]
    const counts = result[key] ??= Object.fromEntries(colors.map((c) => [c, 0]));
    counts[fieldValue] = (counts[fieldValue] ?? 0) + Number(group["__count"] ?? 0);
  }
  return result;
}, { apiModel: true, readonly: true });
