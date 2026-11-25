/**
 * The reflection of `registry.init_models` (registry.py:812-867) written by the port, D23 path B part B1
 * (compiler/VAGB.md): `ir.model._reflect_models`, `ir.model.fields._reflect_fields`,
 * `ir.model.fields.selection._reflect_selections`, `ir.model.constraint._reflect_constraints`,
 * `ir.model.inherit._reflect_inherits` and `ir.model.fields._reflect_field_groups` (base ir_model.py), with their XML ids
 * (`ir.model.data._update_xmlids`).
 *
 * What the registry expects at that step of the install comes from the build (gen/install_capture.py records it per
 * call, without ids: `reflect[n]`, where the capture has the placeholder `@@reflect <n>@@`). What the database holds is
 * read here, so the rows, their ids and the sequences follow this database, not the one the capture was made on: the
 * same statements as Odoo's, with the same comparison (Python equality of the expected row with the selected one) and
 * the same order (the existing rows in the order the SELECT without ORDER BY returns them, then the new ones).
 *
 * `mark_modified` of the upserted rows (a post_init, ir_model.py:62-66) marks no stored field of poc_erp's registry
 * for recompute (none depends on the reflection models' columns): not done.
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { updateXmlids } from "../orm/load_records";

type Row = Record<string, unknown>;

export type Reflect =
  | { kind: "models"; module: string | null; names: string[]; translated: string[]; rows: Row[]; xmlids: string[] }
  | { kind: "fields"; module: string | null; names: string[]; translated: string[]; rows: Row[]; xmlids: [string, string][] }
  | { kind: "selections"; module: string | null; names: string[]; fields: [string, string, [string, string][]][]; xmlids: [string, string, string, string][] }
  | { kind: "constraints"; names: string[]; rows: [string, string, string, string, string, string | null][] }
  | { kind: "inherits"; names: string[]; rows: [string, string, string | null, string[]][] }
  | { kind: "field_groups"; names: string[]; rows: [string, string, string][] }
  | { kind: "constraint"; model: string; name: string; type: string; definition: string | null; module: string | null; message: string | null }
  | { kind: "relation"; model: string; name: string; module: string };

/** The superuser of `init_models`' environment (registry.py:833). */
const SUPERUSER = 1;

const q = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const under = (model: string): string => model.replace(/\./g, "_");

/** Python's `==` on the scalars a reflection row holds (True == 1, 1.0 == 1, None only equals None). */
function pyEq(a: unknown, b: unknown): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  if ((typeof a === "boolean" || typeof a === "number") && (typeof b === "boolean" || typeof b === "number")) return Number(a) === Number(b);
  if (typeof a === "object" || typeof b === "object") return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

function rowsEq(a: readonly unknown[] | undefined, b: readonly unknown[]): boolean {
  return a !== undefined && a.length === b.length && a.every((v, i) => pyEq(v, b[i]));
}

/** `unique(['model', ...] + list(rows[0]))`: the conflict columns first, then the row's keys. */
function columns(first: readonly string[], row: Row): string[] {
  return [...new Set([...first, ...Object.keys(row)])];
}

/** `select_en` (ir_model.py:131-147): the columns of the rows of `model_names`, translated ones in en_US. */
async function selectEn(env: Environment, table: string, cols: readonly string[], translated: ReadonlySet<string>, names: readonly string[]): Promise<unknown[][]> {
  if (!names.length) return [];
  const sel = cols.map((c, i) => `${translated.has(c) ? `${q(c)}->>'en_US'` : q(c)} AS c${i}`).join(", ");
  const res = await env.cr.query<Row>(`SELECT ${sel} FROM ${q(table)} WHERE model = ANY($1::varchar[])`, [[...names]]);
  return res.rows.map((r) => cols.map((_c, i) => r[`c${i}`]));
}

/** `upsert_en` (ir_model.py:150-190): insert or update, the translated columns as {"en_US": value} merged into the
 *  other languages unless the source changed; the ids in the order of the rows. */
async function upsertEn(env: Environment, table: string, cols: readonly string[], translated: ReadonlySet<string>, rows: readonly unknown[][], conflict: readonly string[]): Promise<number[]> {
  if (!rows.length) return [];
  const params: unknown[] = [];
  const values = rows.map((row) => `(${cols.map((c, i) => {
    const v = row[i];
    if (translated.has(c)) {
      params.push(v === null || v === undefined ? null : JSON.stringify({ en_US: v }));
      return `$${params.length}::jsonb`;
    }
    params.push(v === undefined ? null : v);
    return `$${params.length}`;
  }).join(", ")})`).join(", ");
  const set = cols.map((c) => (translated.has(c)
    ? `CASE WHEN ${q(table)}.${q(c)} ->> 'en_US' IS DISTINCT FROM EXCLUDED.${q(c)} ->> 'en_US' THEN EXCLUDED.${q(c)} ELSE COALESCE(${q(table)}.${q(c)}, '{}'::jsonb) || EXCLUDED.${q(c)} END`
    : `EXCLUDED.${q(c)}`)).join(", ");
  const res = await env.cr.query<{ id: number }>(
    `INSERT INTO ${q(table)} (${cols.map(q).join(", ")}) VALUES ${values}
     ON CONFLICT (${conflict.map(q).join(", ")}) DO UPDATE SET (${cols.map(q).join(", ")}) = (${set}) RETURNING id`, params);
  return res.rows.map((r) => r.id);
}

/** `ir.model._get_id` (ir_model.py): the id of a model's row. */
async function modelIds(env: Environment, names: readonly string[]): Promise<Map<string, number>> {
  const res = await env.cr.query<{ id: number; model: string }>("SELECT id, model FROM ir_model WHERE model = ANY($1::varchar[])", [[...names]]);
  return new Map(res.rows.map((r) => [r.model, r.id]));
}

function need<K, V>(m: ReadonlyMap<K, V>, k: K, what: string): V {
  const v = m.get(k);
  if (v === undefined) throw new NotPorted(`reflection: no ${what} ${String(k)}`);
  return v;
}

/** `ir.model.fields._get_ids(model)`: name -> id of a model's fields. */
async function fieldIds(env: Environment, models: readonly string[]): Promise<Map<string, number>> {
  const res = await env.cr.query<{ id: number; model: string; name: string }>(
    "SELECT id, model, name FROM ir_model_fields WHERE model = ANY($1::varchar[])", [[...models]]);
  return new Map(res.rows.map((r) => [`${r.model}\u0000${r.name}`, r.id]));
}

type Xmlid = { xml_id: string; record: number; model: string; noupdate: boolean };

/** `_reflect_models` (ir_model.py:503-540). */
async function reflectModels(env: Environment, r: Extract<Reflect, { kind: "models" }>): Promise<void> {
  const tr = new Set(r.translated);
  const cols = columns(["model"], r.rows[0]!);
  const expected = r.rows.map((row) => cols.map((c) => row[c] ?? null));
  const ids = new Map<string, number>();
  const existing = new Map<string, unknown[]>();
  for (const row of await selectEn(env, "ir_model", ["id", ...cols], tr, r.names)) {
    ids.set(String(row[1]), Number(row[0]));
    existing.set(String(row[1]), row.slice(1));
  }
  const rows = expected.filter((row) => !rowsEq(existing.get(String(row[0])), row));
  const upserted = await upsertEn(env, "ir_model", cols, tr, rows, ["model"]);
  rows.forEach((row, i) => ids.set(String(row[0]), upserted[i]!));
  if (!r.module) return;
  const want = new Set(r.xmlids);
  const data: Xmlid[] = [];
  for (const [name, id] of ids) if (want.has(name)) data.push({ xml_id: `${r.module}.model_${under(name)}`, record: id, model: "ir.model", noupdate: false });
  await updateXmlids(env, data, false);
}

/** `_reflect_fields` (ir_model.py:1367-1428). */
async function reflectFields(env: Environment, r: Extract<Reflect, { kind: "fields" }>): Promise<void> {
  if (!r.rows.length) return;
  const tr = new Set(r.translated);
  const mids = await modelIds(env, r.names);
  const cols = columns(["model", "name"], r.rows[0]!);
  const expected = r.rows.map((row) => cols.map((c) => (c === "model_id" ? need(mids, String(row["model"]), "ir.model") : row[c] ?? null)));
  const key = (row: readonly unknown[]): string => `${String(row[0])}\u0000${String(row[1])}`;
  const ids = new Map<string, number>();
  const existing = new Map<string, unknown[]>();
  for (const row of await selectEn(env, "ir_model_fields", ["id", ...cols], tr, r.names)) {
    ids.set(key(row.slice(1)), Number(row[0]));
    existing.set(key(row.slice(1)), row.slice(1));
  }
  const rows = expected.filter((row) => !rowsEq(existing.get(key(row)), row));
  const upserted = await upsertEn(env, "ir_model_fields", cols, tr, rows, ["model", "name"]);
  rows.forEach((row, i) => ids.set(key(row), upserted[i]!));
  if (!r.module) return;
  const want = new Set(r.xmlids.map(([m, f]) => `${m}\u0000${f}`));
  const data: Xmlid[] = [];
  for (const [k, id] of ids) {
    if (!want.has(k)) continue;
    const [m, f] = k.split("\u0000") as [string, string];
    data.push({ xml_id: `${r.module}.field_${under(m)}__${f}`, record: id, model: "ir.model.fields", noupdate: false });
  }
  await updateXmlids(env, data, false);
}

/** `_reflect_selections` (ir_model.py:1761-1820). */
async function reflectSelections(env: Environment, r: Extract<Reflect, { kind: "selections" }>): Promise<void> {
  if (!r.fields.length) return;
  const fids = await fieldIds(env, [...new Set(r.fields.map(([m]) => m))]);
  const expected = new Map<string, [number, string, string, number]>();
  for (const [model, name, selection] of r.fields) {
    const fid = need(fids, `${model}\u0000${name}`, "ir.model.fields");
    selection.forEach(([value, label], index) => {
      const k = `${fid}\u0000${value}`;
      const prev = expected.get(k);
      // a dict: a repeated key keeps its place and takes the last value
      if (prev) { prev[2] = label; prev[3] = index; } else expected.set(k, [fid, value, label, index]);
    });
  }
  const existing = new Map<string, [string | null, number]>();
  for (const row of (await env.cr.query<{ field_id: number; value: string; name: string | null; sequence: number }>(
    `SELECT s.field_id, s.value, s.name->>'en_US' AS name, s.sequence FROM ir_model_fields_selection s, ir_model_fields f
      WHERE s.field_id = f.id AND f.model = ANY($1::varchar[])`, [[...r.names]])).rows) {
    existing.set(`${row.field_id}\u0000${row.value}`, [row.name, row.sequence]);
  }
  const rows = [...expected.entries()].filter(([k, v]) => !rowsEq(existing.get(k), [v[2], v[3]])).map(([, v]) => v as unknown[]);
  await upsertEn(env, "ir_model_fields_selection", ["field_id", "value", "name", "sequence"], new Set(["name"]), rows, ["field_id", "value"]);
  if (!r.module) return;
  const sel = new Map<string, number>();
  for (const row of (await env.cr.query<{ model: string; name: string; value: string; id: number }>(
    `SELECT f.model, f.name, s.value, s.id FROM ir_model_fields_selection s, ir_model_fields f
      WHERE s.field_id = f.id AND f.model = ANY($1::varchar[])`, [[...r.names]])).rows) {
    sel.set(`${row.model}\u0000${row.name}\u0000${row.value}`, row.id);
  }
  const data: Xmlid[] = r.xmlids.map(([model, field, value, module]) => ({
    xml_id: `${module}.selection__${under(model)}__${field}__${value.replace(/\./g, "_").replace(/ /g, "_").toLowerCase()}`,
    record: need(sel, `${model}\u0000${field}\u0000${value}`, "ir.model.fields.selection"), model: "ir.model.fields.selection", noupdate: false,
  }));
  await updateXmlids(env, data, false);
}

/** `_reflect_constraint` (ir_model.py:2156-2200): the constraint's row, inserted when the module has none of that name,
 *  updated when its type, definition or message changed; its id (null without a module). */
async function reflectConstraint(env: Environment, model: string, conname: string, type: string, definition: string | null,
  module: string | null, message: string | null): Promise<number | null> {
  if (!module) return null;
  const rows = (await env.cr.query<{ id: number; type: string; definition: string | null; message: unknown }>(
    `SELECT c.id, type, definition, message->'en_US' as message FROM ir_model_constraint c, ir_module_module m
      WHERE c.module = m.id AND c.name = $1 AND m.name = $2`, [conname, module])).rows;
  if (!rows.length) {
    return (await env.cr.query<{ id: number }>(
      `INSERT INTO ir_model_constraint (name, create_date, write_date, create_uid, write_uid, module, model, type, definition, message)
       VALUES ($1, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', $2, $2, (SELECT id FROM ir_module_module WHERE name=$3),
               (SELECT id FROM ir_model WHERE model=$4), $5, $6, $7::jsonb) RETURNING id`,
      [conname, SUPERUSER, module, model, type, definition, JSON.stringify({ en_US: message })])).rows[0]!.id;
  }
  if (rows.length > 1) throw new NotPorted(`reflection: constraint ${conname} of ${module} twice`);
  const c = rows[0]!;
  if (!(c.type === type && c.definition === definition && pyEq(c.message, message))) {
    await env.cr.query(
      `UPDATE ir_model_constraint SET write_date=now() AT TIME ZONE 'UTC', write_uid = $1, type = $2, definition = $3, message = $4::jsonb WHERE id = $5`,
      [SUPERUSER, type, definition, JSON.stringify({ en_US: message }), c.id]);
  }
  return c.id;
}

/** `_reflect_relation` (ir_model.py:2274-2293): a many2many table's row, inserted when the module has none of that name. */
async function reflectRelation(env: Environment, r: Extract<Reflect, { kind: "relation" }>): Promise<void> {
  const found = (await env.cr.query(`SELECT 1 FROM ir_model_relation r, ir_module_module m WHERE r.module=m.id AND r.name=$1 AND m.name=$2`,
    [r.name, r.module])).rows.length;
  if (found) return;
  await env.cr.query(
    `INSERT INTO ir_model_relation (name, create_date, write_date, create_uid, write_uid, module, model)
     VALUES ($1, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC', $2, $2, (SELECT id FROM ir_module_module WHERE name=$3),
             (SELECT id FROM ir_model WHERE model=$4))`, [r.name, SUPERUSER, r.module, r.model]);
}

/** `_reflect_constraints` (ir_model.py:2202-2227) through `_reflect_constraint` (:2156-2200). */
async function reflectConstraints(env: Environment, r: Extract<Reflect, { kind: "constraints" }>): Promise<void> {
  const data: Xmlid[] = [];
  for (const [model, conname, type, definition, module, message] of r.rows) {
    const id = (await reflectConstraint(env, model, conname, type, definition, module, message))!;
    data.push({ xml_id: `${module}.constraint_${conname}`, record: id, model: "ir.model.constraint", noupdate: false });
  }
  await updateXmlids(env, data, false);
}

/** `_reflect_inherits` (ir_model.py:1654-1725). */
async function reflectInherits(env: Environment, r: Extract<Reflect, { kind: "inherits" }>): Promise<void> {
  if (!r.rows.length) return;
  const mids = await modelIds(env, [...new Set(r.rows.flatMap(([m, p]) => [m, p]))]);
  const fids = await fieldIds(env, [...new Set(r.rows.map(([m]) => m))]);
  const items = r.rows.map(([model, parent, field, modules]) => ({
    model, parent, modules,
    key: [need(mids, model, "ir.model"), need(mids, parent, "ir.model"), field === null ? null : fids.get(`${model}\u0000${field}`) ?? null] as [number, number, number | null],
  }));
  const existing = new Map<string, number | null>();
  const inhIds = new Map<string, number>();
  for (const row of (await env.cr.query<{ id: number; model_id: number; parent_id: number; parent_field_id: number | null }>(
    `SELECT i.id, i.model_id, i.parent_id, i.parent_field_id FROM ir_model_inherit i JOIN ir_model m ON m.id = i.model_id
      WHERE m.model = ANY($1::varchar[])`, [[...r.names]])).rows) {
    inhIds.set(JSON.stringify([row.model_id, row.parent_id, row.parent_field_id]), row.id);
    existing.set(JSON.stringify([row.model_id, row.parent_id]), row.parent_field_id);
  }
  const rows = items.filter((it) => {
    const k = JSON.stringify(it.key.slice(0, 2));
    return !existing.has(k) || !pyEq(existing.get(k), it.key[2]);
  }).map((it) => it.key as unknown[]);
  const ids = await upsertEn(env, "ir_model_inherit", ["model_id", "parent_id", "parent_field_id"], new Set(), rows, ["model_id", "parent_id"]);
  rows.forEach((row, i) => inhIds.set(JSON.stringify(row), ids[i]!));
  const data: Xmlid[] = [];
  for (const it of items) {
    const id = need(inhIds, JSON.stringify(it.key), "ir.model.inherit");
    for (const module of it.modules) {
      data.push({ xml_id: `${module}.model_inherit__${under(it.model)}__${under(it.parent)}`, record: id, model: "ir.model.inherit", noupdate: false });
    }
  }
  await updateXmlids(env, data, false);
}

/** `_reflect_field_groups` (ir_model.py:1430-1485). */
async function reflectFieldGroups(env: Environment, r: Extract<Reflect, { kind: "field_groups" }>): Promise<void> {
  if (!r.names.length) return;
  const mids = await modelIds(env, r.names);
  const modelIdList = r.names.map((n) => need(mids, n, "ir.model"));
  const existing = new Set((await env.cr.query<{ f: number; g: number }>(
    `SELECT r.field_id AS f, r.group_id AS g FROM ir_model_fields_group_rel r JOIN ir_model_fields f ON f.id = r.field_id
      WHERE f.model_id = ANY($1::int[])`, [modelIdList])).rows.map((x) => `${x.f},${x.g}`));
  const fids = await fieldIds(env, r.names);
  const groups = new Map<string, number>();
  const xmlids = [...new Set(r.rows.map(([, , x]) => x))];
  if (xmlids.length) {
    for (const row of (await env.cr.query<{ x: string; res_id: number; model: string }>(
      `SELECT d.module || '.' || d.name AS x, d.res_id, d.model FROM ir_model_data d
         JOIN UNNEST($1::varchar[], $2::varchar[]) AS x(module, name) ON d.module = x.module AND d.name = x.name`,
      [xmlids.map((x) => x.split(".")[0]), xmlids.map((x) => x.slice(x.indexOf(".") + 1))])).rows) {
      if (row.model !== "res.groups") throw new NotPorted(`reflection: ${row.x} is not a group`);
      groups.set(row.x, row.res_id);
    }
  }
  const expected = new Set<string>();
  for (const [model, field, x] of r.rows) {
    expected.add(`${need(fids, `${model}\u0000${field}`, "ir.model.fields")},${need(groups, x, "group xmlid")}`);
  }
  const pairs = (s: Iterable<string>): [number, number][] => [...s].map((k) => k.split(",").map(Number) as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const add = pairs([...expected].filter((k) => !existing.has(k)));
  const remove = pairs([...existing].filter((k) => !expected.has(k)));
  if (add.length) {
    await env.cr.query("INSERT INTO ir_model_fields_group_rel(field_id, group_id) SELECT * FROM UNNEST($1::int[], $2::int[])",
      [add.map((p) => p[0]), add.map((p) => p[1])]);
  }
  if (remove.length) {
    await env.cr.query(`DELETE FROM ir_model_fields_group_rel rel WHERE EXISTS (SELECT FROM UNNEST($1::int[], $2::int[]) AS rm(field_id, group_id)
      WHERE rm.field_id = rel.field_id AND rm.group_id = rel.group_id)`, [remove.map((p) => p[0]), remove.map((p) => p[1])]);
  }
}

/** One recorded reflection call of `init_models` or of the end of the load. */
export async function applyReflection(env: Environment, r: Reflect): Promise<void> {
  switch (r.kind) {
    case "models": return reflectModels(env, r);
    case "fields": return reflectFields(env, r);
    case "selections": return reflectSelections(env, r);
    case "constraints": return reflectConstraints(env, r);
    case "inherits": return reflectInherits(env, r);
    case "field_groups": return reflectFieldGroups(env, r);
    case "constraint": await reflectConstraint(env, r.model, r.name, r.type, r.definition, r.module, r.message); return;
    case "relation": return reflectRelation(env, r);
  }
}
