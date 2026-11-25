/**
 * `formatted_read_grouping_sets` (odoo/addons/web/models/models.py:920-1019) over `_read_grouping_sets`
 * (odoo/odoo/orm/models.py:1677-1900). Odoo runs one `GROUP BY GROUPING SETS (...)` query ordered by the union of
 * the sets' specs; the rows of one set have NULL in the columns of the other specs, so their relative order is the
 * order restricted to the set's own terms (and the aggregates). Each set is therefore computed as its own
 * `formatted_read_group` with that restricted order: the same expand (models.py:1001-1003), fill_temporal
 * (:1005-1013) and `_web_read_group_format` (:1015-1018) steps.
 *
 * Not ported: grouping sets on many2many or tag properties with row-duplication-sensitive aggregates (the
 * recursive decomposition of models.py:1740-1820): the JS `_read_group` fallback already refuses many2many groupbys.
 */
import { NotPorted } from "../errors";
import { parseDomain, PyValueError } from "../orm/domain";
import { envFor, optStr } from "./common";
import { formattedReadGroup, parseOrderPart, type FormattedGroup } from "./read_group";
import { registerBaseMethod } from "./register";
import type { Domain, Environment } from "../orm/types";

function stringList(v: unknown, what: string): string[] {
  if (v === null || v === undefined || v === false) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new NotPorted(`${what} must be a list of strings`);
  return v.map(String);
}

export async function formattedReadGroupingSets(
  env: Environment, model: string, domain: Domain, groupingSets: readonly (readonly string[])[], aggregatesIn: readonly string[],
  orderIn: string | null,
): Promise<FormattedGroup[][]> {
  // orm/models.py:1728-1729
  if (groupingSets.length === 0) throw new PyValueError("The 'grouping_sets' parameter cannot be empty.");
  const aggregates = aggregatesIn.map((agg) => agg.replace(":recordset", ":array_agg"));
  const allSpecs = [...new Set(groupingSets.flat())];
  // models.py:995-996: the default order is every groupby spec once, in order
  const order = orderIn !== null && orderIn !== "" ? orderIn : allSpecs.join(", ");
  const out: FormattedGroup[][] = [];
  for (const groupby of groupingSets) {
    const own = new Set(groupby);
    const parts = order.split(",").map((p) => p.trim()).filter((p) => p !== "").filter((p) => {
      const term = parseOrderPart(p, order, "_read_grouping_sets()").term;
      return own.has(term) || !allSpecs.includes(term);
    });
    // Odoo's GROUPING SETS query itself gives the float aggregates (read_group.ts odooGroupQuery)
    out.push(await formattedReadGroup(env, model, domain, groupby, aggregates, [], 0, null, parts.join(", "),
      { sets: groupingSets, all: allSpecs, order }));
  }
  return out;
}

registerBaseMethod("formatted_read_grouping_sets", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const sets = kwargs["grouping_sets"] ?? args[1];
  if (!Array.isArray(sets)) throw new NotPorted("formatted_read_grouping_sets: grouping_sets must be a list");
  return formattedReadGroupingSets(
    env, model,
    parseDomain(kwargs["domain"] ?? args[0]),
    sets.map((s, i) => stringList(s, `grouping_sets[${i}]`)),
    stringList(kwargs["aggregates"] ?? args[2], "aggregates"),
    optStr(kwargs["order"], "order"),
  );
}, { apiModel: true, readonly: true });
