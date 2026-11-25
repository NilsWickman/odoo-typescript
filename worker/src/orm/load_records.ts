/**
 * `BaseModel._load_records` (orm/models.py:4619-4724) with `ir.model.data._update_xmlids` (ir_model.py:2446-2524):
 * create or update records by XML id, as data files and `load()` with external ids do.
 */
import { NotPorted, ValidationError } from "../errors";
import { create } from "./create";
import { write } from "./write";
import { unlink } from "./unlink";
import type { Environment } from "./types";

/** `registry.loaded_xmlids` (models.py:4700-4703) of a module load that tracks them (src/modules/upgrade.ts: `_process_end`). */
const LOADED = new WeakMap<object, Set<string>>();
export function trackLoadedXmlids(cr: object): Set<string> {
  const set = new Set<string>();
  LOADED.set(cr, set);
  return set;
}
export function untrackLoadedXmlids(cr: object): void {
  LOADED.delete(cr);
}

export interface LoadData { xml_id?: string; values: Record<string, unknown>; noupdate?: boolean; record?: number }

/** `_load_records_create` overrides (models.py:4726-4730 is `self.create(values)`; res.partner overrides it). */
const LOAD_CREATE = new Map<string, (env: Environment, valsList: Record<string, unknown>[]) => Promise<number[]>>();
export function registerLoadRecordsCreate(model: string, fn: (env: Environment, valsList: Record<string, unknown>[]) => Promise<number[]>): void {
  LOAD_CREATE.set(model, fn);
}
/** `_load_records_write` overrides (models.py:4596-4611 is `self.write(values)` for one record; account.account drops
 *  `prefix` and `code_digits`, account_account.py:1149-1153). */
const LOAD_WRITE = new Map<string, (env: Environment, id: number, values: Record<string, unknown>) => Promise<void>>();
export function registerLoadRecordsWrite(model: string, fn: (env: Environment, id: number, values: Record<string, unknown>) => Promise<void>): void {
  LOAD_WRITE.set(model, fn);
}
/** `model._load_records_create(vals_list)`. */
export async function loadRecordsCreate(env: Environment, model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
  const fn = LOAD_CREATE.get(model);
  return fn ? fn(env, valsList) : create(env, model, valsList);
}

/** `_load_records` (orm/models.py:4619-4724): create or update records and assign their XML ids. */
export async function loadRecords(env: Environment, model: string, dataList: LoadData[], update: boolean): Promise<number[]> {
  const def = env.reg.model(model);
  const xmlIds = dataList.map((d) => d.xml_id).filter((x): x is string => !!x);
  const existing = new Map<string, { id: number; model: string; res_id: number; noupdate: boolean; r_id: number | null }>();
  const byModule = new Map<string, string[]>();
  for (const x of xmlIds) {
    const dot = x.indexOf(".");
    const list = byModule.get(x.slice(0, dot)) ?? [];
    list.push(x.slice(dot + 1));
    byModule.set(x.slice(0, dot), list);
  }
  for (const [prefix, suffixes] of byModule) {
    const rows = (await env.cr.query<{ id: number; module: string; name: string; model: string; res_id: number; noupdate: boolean; r_id: number | null }>(
      `SELECT d.id, d.module, d.name, d.model, d.res_id, d.noupdate, r.id AS r_id
         FROM ir_model_data d LEFT JOIN "${def.table}" r ON d.res_id = r.id
        WHERE d.module = $1 AND d.name = ANY($2::varchar[])`, [prefix, suffixes])).rows;
    for (const r of rows) existing.set(`${r.module}.${r.name}`, r);
  }
  const toCreate: LoadData[] = [];
  const toUpdate: LoadData[] = [];
  const imdDataList: { xml_id: string; record: number; model: string; noupdate: boolean }[] = [];
  for (const data of dataList) {
    if (!data.xml_id) {
      if (data.values["id"]) { data.record = Number(data.values["id"]); toUpdate.push(data); } else if (!update) toCreate.push(data);
      else throw new ValidationError("Cannot update a record without specifying its id or xml_id");
      continue;
    }
    const row = existing.get(data.xml_id);
    if (!row) { toCreate.push(data); continue; }
    if (row.model !== model) {
      throw new ValidationError(`For external id ${data.xml_id} when trying to create/update a record of model ${model} found record of different model ${row.model} (${row.id})`);
    }
    if (row.r_id !== null) {
      data.record = row.res_id;
      imdDataList.push({ xml_id: data.xml_id, record: row.res_id, model, noupdate: !!data.noupdate });
      if (!(update && row.noupdate)) toUpdate.push(data);
    } else {
      await unlink(env.sudo(), "ir.model.data", [row.id]);
      toCreate.push(data);
    }
  }
  // models.py:4682-4684 `data['record']._load_records_write(data['values'])`
  const loadWrite = LOAD_WRITE.get(model);
  for (const data of toUpdate) {
    if (loadWrite) await loadWrite(env, data.record!, data.values);
    else await write(env, model, [data.record!], data.values);
  }
  if (toCreate.length) {
    const ids = await loadRecordsCreate(env, model, toCreate.map((d) => d.values));
    for (let i = 0; i < toCreate.length; i++) {
      const data = toCreate[i]!;
      data.record = ids[i]!;
      if (data.xml_id) {
        // models.py:4711-4717: the XML ids of the parents just created, `<xml_id>_<parent table>`
        for (const [parentModel, parentField] of def.inherits) {
          if (data.values[parentField]) continue;
          const parent = (await env.cr.query<{ p: number }>(`SELECT "${parentField}" AS p FROM "${def.table}" WHERE id = $1`, [data.record])).rows[0]!.p;
          imdDataList.push({ xml_id: `${data.xml_id}_${parentModel.replaceAll(".", "_")}`, record: parent, model: parentModel, noupdate: !!data.noupdate });
        }
        imdDataList.push({ xml_id: data.xml_id, record: data.record, model, noupdate: !!data.noupdate });
      }
    }
  }
  await updateXmlids(env, imdDataList, update);
  return dataList.map((d) => d.record!);
}

/** `ir.model.data._update_xmlids` (ir_model.py:2446-2524). */
export async function updateXmlids(env: Environment, dataList: readonly { xml_id: string; record: number; model: string; noupdate: boolean }[], update: boolean): Promise<void> {
  const seen = new Set<string>();
  const rows: [string, string, string, number, boolean][] = [];
  for (const d of dataList) {
    const dot = d.xml_id.indexOf(".");
    const row: [string, string, string, number, boolean] = [d.xml_id.slice(0, dot), d.xml_id.slice(dot + 1), d.model, d.record, d.noupdate];
    const key = JSON.stringify(row);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  if (!rows.length) return;
  // ir_model.py:2487-2489: the rows are loaded xmlids (`_process_end`)
  const loaded = LOADED.get(env.cr);
  if (loaded) for (const r of rows) loaded.add(`${r[0]}.${r[1]}`);
  await env.cr.query(
    `INSERT INTO ir_model_data(module, name, model, res_id, noupdate)
     SELECT * FROM UNNEST($1::varchar[], $2::varchar[], $3::varchar[], $4::int[], $5::bool[])
     ON CONFLICT (module, name)
     DO UPDATE SET (model, res_id, write_date) = (EXCLUDED.model, EXCLUDED.res_id, now() at time zone 'UTC')
       WHERE (ir_model_data.res_id != EXCLUDED.res_id OR ir_model_data.model != EXCLUDED.model)${update ? " AND NOT ir_model_data.noupdate" : ""}`,
    [rows.map((r) => r[0]), rows.map((r) => r[1]), rows.map((r) => r[2]), rows.map((r) => r[3]), rows.map((r) => r[4])]);
}

