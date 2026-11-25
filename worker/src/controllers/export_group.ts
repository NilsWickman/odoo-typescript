/**
 * The grouped xlsx export of `/web/export/xlsx`: `ExportFormat.base` (odoo/addons/web/controllers/export.py:449-493),
 * `GroupsTreeNode` (:69-164) and `GroupExportXlsxWriter` (:249-287). The tree is built from `formatted_read_group`
 * and the rows of `export_data(['.id'] + field_names)`, then flattened into the rows `buildXlsx` writes.
 */
import { NotPorted } from "../errors";
import type { Domain, Environment } from "../orm/types";
import { translate } from "../models/util";
import { formattedReadGroup } from "../web/read_group";
import type { ExportCell } from "./export_csv";
import type { XlsxCell, XlsxRow } from "./export_xlsx";

type Aggregate = number | boolean | null;

/** A cell as the Python number or boolean it is, for the aggregators; anything else was not aggregated by a field. */
function native(v: ExportCell, field: string): number | boolean {
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") return v.float;
  throw new NotPorted(`export aggregate of a non-numeric value of ${field}`);
}

/** export.py:39-46 OPERATOR_MAPPING, with `none_values_filtered` and `allow_empty_iterable`. */
function aggregateOf(aggregator: string, field: string, values: readonly Aggregate[]): Aggregate {
  const present = values.filter((v): v is number | boolean => v !== null);
  switch (aggregator) {
    case "sum": return present.reduce<number>((s, v) => s + Number(v), 0);
    case "max": return present.length ? Math.max(...present.map(Number)) : null;
    case "min": return present.length ? Math.min(...present.map(Number)) : null;
    case "bool_and": return values.every(Boolean);
    case "bool_or": return values.some(Boolean);
    default: throw new NotPorted(`export of aggregator ${aggregator} for field ${field}`); // :83-84 logs and gives None
  }
}

class GroupNode {
  count = 0;
  readonly children = new Map<string, { key: unknown; node: GroupNode }>();
  data: readonly (readonly ExportCell[])[] = [];
  private aggregated: Map<string, Aggregate> | null = null;

  constructor(private readonly env: Environment, private readonly model: string, private readonly fieldNames: readonly string[]) {}

  /** :120-128 `child`. */
  child(key: unknown): GroupNode {
    const k = JSON.stringify(key);
    let entry = this.children.get(k);
    if (!entry) {
      entry = { key, node: new GroupNode(this.env, this.model, this.fieldNames) };
      this.children.set(k, entry);
    }
    return entry.node;
  }

  /** :92-103 `_get_avg_aggregate`. */
  private average(name: string, data: readonly Aggregate[]): Aggregate {
    if (!this.count) return null;
    if (this.data.length) return data.reduce<number>((s, v) => s + Number(v), 0) / this.count;
    let sum = 0;
    for (const { node } of this.children.values()) {
      const v = node.values().get(name);
      if (v === null || v === undefined) throw new NotPorted("average of a group without a value (None * count)"); // TypeError in Odoo
      sum += Number(v) * node.count;
    }
    return sum / this.count;
  }

  /** :116-118 `aggregated_values`, memoized as the cached_property is. */
  values(): Map<string, Aggregate> {
    if (this.aggregated) return this.aggregated;
    const fields = this.env.reg.model(this.model).fields;
    const out = new Map<string, Aggregate>();
    this.fieldNames.forEach((name, col) => {
      const aggregator = name.includes("/") ? null : fields.get(name)?.aggregator ?? null; // :105-114 `_get_aggregated_field_names`
      if (!aggregator) return;
      const data = this.data.map((row) => row[col]!).filter((v) => v !== "").map((v) => native(v, name)); // :79-81
      if (aggregator === "avg") out.set(name, this.average(name, data));
      else if (this.data.length) out.set(name, aggregateOf(aggregator, name, data));
      else out.set(name, aggregateOf(aggregator, name, [...this.children.values()].map(({ node }) => node.values().get(name) ?? null)));
    });
    this.aggregated = out;
    return out;
  }
}

/** export.py:252-254 the label of a group value, `group_name[1]` of a (value, label) pair. */
function groupLabel(env: Environment, key: unknown, type: string | undefined): string {
  const name = Array.isArray(key) && key.length > 1 ? key[1] : key;
  if (type === "boolean") return name ? "True" : "False";
  if (name === false || name === null || name === undefined || name === "" || name === 0) return translate(env, "Undefined");
  if (typeof name === "string") return name;
  if (Number.isInteger(name)) return String(name);
  throw new NotPorted(`grouped export label ${JSON.stringify(name)}`);
}

/** :271-287 `_write_group_header`: the first column is the label, the others the aggregated values. */
function headerRow(env: Environment, node: GroupNode, label: string, depth: number,
  fields: readonly { name: string; type: string }[]): XlsxRow {
  const cells: XlsxCell[] = [`${"    ".repeat(depth)}${label} (${node.count})`];
  const aggregates = node.values();
  for (const field of fields.slice(1)) {
    const value = aggregates.get(field.name) ?? null;
    if (field.type === "monetary" || field.type === "float") {
      if (typeof value === "boolean") throw new NotPorted(`boolean aggregate of ${field.name}`);
      cells.push(value);
    } else if (value === null) cells.push("");
    else if (typeof value === "boolean") cells.push(value ? "True" : "False"); // str(value)
    else if (Number.isInteger(value)) cells.push(String(value));
    else throw new NotPorted(`str() of the aggregate ${value} of ${field.name}`);
  }
  return { groupHeader: cells };
}

/** :251-263 `write_group`. */
function writeGroup(env: Environment, out: XlsxRow[], key: unknown, node: GroupNode, types: readonly string[], depth: number,
  fields: readonly { name: string; type: string }[]): void {
  out.push(headerRow(env, node, groupLabel(env, key, types[depth]), depth, fields));
  for (const { key: childKey, node: child } of node.children.values()) writeGroup(env, out, childKey, child, types, depth + 1, fields);
  out.push(...node.data);
}

/**
 * The rows under the header of a grouped export. `exportRows` are the lines of `export_data(['.id'] + field_names)`
 * for `recordIds`; `fields` are the dialog's fields.
 */
export async function groupedRows(env: Environment, model: string, fields: readonly { name: string; type: string }[], groupby: readonly string[],
  recordIds: readonly number[], domain: Domain, exportRows: readonly (readonly ExportCell[])[]): Promise<XlsxRow[]> {
  const def = env.reg.model(model);
  const groupbyType = groupby.map((g) => {
    const field = def.fields.get(g.split(":", 1)[0]!.split(".", 1)[0]!);
    if (!field) throw new NotPorted(`grouped export by ${g}`);
    return field.type;
  });
  const groupsData = await formattedReadGroup(env, model, domain, groupby, ["__count", "id:array_agg"]);
  // :467-473 a line with an id starts its record, the following ones (x2many sublines) continue it
  const recordRows = new Map<number, (readonly ExportCell[])[]>(recordIds.map((id) => [id, []]));
  let current: (readonly ExportCell[])[] | undefined;
  for (const row of exportRows) {
    if (row[0]) current = recordRows.get(Number(row[0]));
    if (!current) throw new NotPorted("export line without a record");
    current.push(row.slice(1));
  }
  // :478-487 the records of a group keep the order of `export_data`
  const memberships = new Map<number, number[]>();
  groupsData.forEach((group, index) => {
    for (const id of group["id:array_agg"] as number[]) memberships.set(id, [...(memberships.get(id) ?? []), index]);
  });
  const groupedData: (readonly ExportCell[])[][] = groupsData.map(() => []);
  for (const [id, rows] of recordRows) for (const index of memberships.get(id) ?? []) groupedData[index]!.push(...rows);
  // :153-164 `insert_leaf`
  const root = new GroupNode(env, model, fields.map((f) => f.name));
  groupsData.forEach((group, index) => {
    const count = Number(group["__count"]);
    let node = root;
    node.count += count;
    for (const spec of groupby) {
      node = node.child(group[spec]);
      node.count += count;
    }
    node.data = groupedData[index]!;
  });
  const out: XlsxRow[] = [];
  for (const { key, node } of root.children.values()) writeGroup(env, out, key, node, groupbyType, 0, fields);
  return out;
}
