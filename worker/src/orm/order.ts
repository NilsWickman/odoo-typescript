/** BaseModel._order_to_sql/_order_field_to_sql (odoo/orm/models.py:4735-4850). */
import { NotPorted, UserError } from "../errors";
import { PyValueError } from "./domain";
import { hooksOf } from "./hooks";
import { joinMany2one, raw, sql, Sql, type Table } from "./sql";

/** models.py:88-99 `regex_order` (re.IGNORECASE | re.VERBOSE): a comma-separated list of terms, not ending in a comma. */
const REGEX_ORDER = /^(\s*(([a-z0-9_]+)(\.([a-z0-9_]+))?(:([a-z_]+))?)(\s+(desc|asc))?(\s+(nulls first|nulls last))?\s*(,|$))+(?<!,)$/i;

/** `groupby` collects what Odoo appends to `query._order_groupby` (models.py:4813, :4847): the plain terms, which
 *  `_read_group_orderby` adds to the GROUP BY of a many2one ordered by its comodel (models.py:2255-2262). */
export async function orderToSql(table: Table, order: string, reverse = false, seen = new Set<string>(), groupby?: Sql[]): Promise<Sql> {
  // models.py:4726-4733 `_check_qorder`, called first by `_order_to_sql` (:4743)
  if (order && !REGEX_ORDER.test(order)) {
    throw new UserError(`Invalid "order" specified (${order}). A valid "order" specification is a comma-separated list of valid field names (optionally followed by asc/desc for the direction)`);
  }
  const terms: Sql[] = [];
  for (const part of (order || table.model.order).split(",")) {
    if (!part.trim()) continue;
    const m = /^\s*([a-zA-Z0-9_]+)(?:\.([\w]+))?\s*(asc|desc)?\s*(nulls\s+(?:first|last))?\s*$/i.exec(part);
    if (!m) throw new PyValueError(`Invalid order ${order}`);
    const field = table.fieldDef(m[1]!);
    let direction = (m[3] ?? "").toUpperCase();
    let nulls = (m[4] ?? "").toUpperCase().replace(/\s+/g, " ");
    if (reverse) {
      direction = direction === "DESC" ? "ASC" : "DESC";
      if (nulls) nulls = nulls === "NULLS FIRST" ? "NULLS LAST" : "NULLS FIRST";
    }
    let value = await table.field(field.name);
    if (field.type === "many2one" && m[2] !== "id") {
      if (m[2]) throw new PyValueError(`Cannot order by comodel fields in '${m[1]}.${m[2]}'`);
      const key = `${table.model.name}.${field.name}`;
      if (seen.has(key)) continue;
      // models.py:4810-4814: a comodel ordered by id orders by the column itself, without a join
      if (groupby && table.env.reg.model(field.relation!).order === "id") {
        groupby.push(value);
        terms.push(sql`${value} ${raw(direction)} ${raw(nulls)}`);
        continue;
      }
      const next = new Set([...seen, key]);
      if (nulls) terms.push(sql`${value} ${raw(nulls === "NULLS FIRST" ? "IS NOT NULL" : "IS NULL")}`);
      const joined = await joinMany2one(table.sudo(), field);
      terms.push(await orderToSql(joined, joined.model.order, direction === "DESC", next, groupby));
      continue;
    }
    if (m[2] && field.type !== "many2one") throw new NotPorted(`ordering property ${m[1]}.${m[2]}`);
    if (field.type === "boolean" && !field.notNull) value = sql`COALESCE(${value}, FALSE)`;
    if (field.type === "selection") {
      const hook = hooksOf(table.model.name).selection?.[field.name];
      const keys = field.selection?.map(s => s.value) ?? (hook ? (await hook(table.env)).map(s => s[0]) : null);
      if (keys === null) throw new NotPorted(`selection order ${table.model.name}.${field.name}`);
      value = sql`array_position(${keys}::text[], ${value}::text)`;
    }
    groupby?.push(value);
    terms.push(sql`${value} ${raw(direction)} ${raw(nulls)}`);
  }
  return Sql.join(", ", terms.filter(t => !t.isEmpty()));
}
