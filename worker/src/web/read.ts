/**
 * `web_read` and its specification recursion (`odoo/addons/web/models/models.py:315-520`, Odoo 20).
 * Values come from `Model.read(ids, fields, 'web')` (many2one as a bare id, binary as {size, checksum},
 * models.py:3014 `_read_format`); this module only follows the relations the specification asks for.
 */
import { AccessError, NotPorted } from "../errors";
import type { Context, Environment, FieldDef, ModelDef, RecordValues } from "../orm/types";
import { type FieldSpec, type Specification, envFor, hasKey, isRecord, parseSpecification, recordIds } from "./common";
import { cond } from "../orm/domain";
import { checkFieldAccess } from "../orm/sql";
import { registerBaseMethod } from "./register";
import { displayNamesOrFalse } from "../orm/model";

/** `with_context(**kwargs)` updates the context (environments.py with_context: kwargs merge). */
function withSubContext(env: Environment, ctx: Context | undefined): Environment {
  return ctx === undefined ? env : env.withContext({ ...env.context, ...ctx });
}

function idOf(vals: RecordValues): number {
  const id = vals["id"];
  if (typeof id !== "number") throw new NotPorted(`read() returned a record without an integer id: ${JSON.stringify(id)}`);
  return id;
}

function idList(value: unknown, field: string): number[] {
  if (!Array.isArray(value)) throw new NotPorted(`read() of x2many ${field} returned ${JSON.stringify(value)}`);
  return value.map((x) => {
    if (typeof x !== "number") throw new NotPorted(`read() of x2many ${field} returned a non-integer id`);
    return x;
  });
}

export async function webRead(env: Environment, model: string, ids: readonly number[], specification: Specification): Promise<RecordValues[]> {
  const def = env.reg.model(model);
  const fieldsToRead = Object.keys(specification);
  let valuesList: RecordValues[];
  if (fieldsToRead.length === 0 || (fieldsToRead.length === 1 && fieldsToRead[0] === "id")) {
    // models.py:369: only ids requested, no read (and no access check on the comodel).
    valuesList = ids.map((id) => ({ id }));
  } else if (ids.length === 0 && !env.su) {
    // models.py read(): an empty recordset only checks the fields (`_determine_fields_to_fetch`); `fetch` returns
    // before `check_access('read')`, so a user without access to the comodel reads an empty x2many
    for (const name of fieldsToRead) {
      const field = def.fields.get(name);
      if (field !== undefined) await checkFieldAccess(env, def, field, "read");
    }
    valuesList = [];
  } else {
    valuesList = await env.model(model).read(ids, fieldsToRead, "web");
  }
  if (valuesList.length === 0) return valuesList;

  // many2one fields that ask for nothing but the display name (a form's usual ones): their names are read together,
  // sent at once (they share round trips); each one's result, or its error, is taken in the specification's order
  const early = new Map<string, Promise<{ ok: true } | { ok: false; e: unknown }>>();
  for (const [fieldName, fieldSpec] of Object.entries(specification)) {
    const field = def.fields.get(fieldName);
    if (field?.type !== "many2one" || !hasKey(fieldSpec, "fields") || fieldSpec.fields === undefined) continue;
    if (!Object.keys(fieldSpec.fields).every((k) => k === "display_name")) continue;
    early.set(fieldName, readMany2one(env, field, fieldName, fieldSpec, valuesList).then(() => ({ ok: true as const }), (e: unknown) => ({ ok: false as const, e })));
  }
  try {
    await followRelations(env, def, specification, valuesList, early);
  } finally {
    await Promise.all(early.values()); // none left running when another field's error is thrown
  }
  return valuesList;
}

async function followRelations(env: Environment, def: ModelDef, specification: Specification, valuesList: RecordValues[], early: ReadonlyMap<string, Promise<{ ok: true } | { ok: false; e: unknown }>>): Promise<void> {
  for (const [fieldName, fieldSpec] of Object.entries(specification)) {
    const field = def.fields.get(fieldName);
    if (field === undefined) continue; // models.py:383: unknown names are ignored

    switch (field.type) {
      case "many2one": {
        const started = early.get(fieldName);
        if (started === undefined) await readMany2one(env, field, fieldName, fieldSpec, valuesList);
        else {
          const r = await started;
          if (!r.ok) throw r.e;
        }
        break;
      }
      case "one2many":
      case "many2many":
        await readX2many(env, field, fieldName, fieldSpec, valuesList);
        break;
      case "reference":
      case "many2one_reference":
        if (fieldSpec.empty) break;
        // models.py:466-467: records whose value is empty are skipped (they keep `false`)
        if (valuesList.every((v) => !v[fieldName])) break;
        await readReference(env, def.name, field, fieldName, fieldSpec, valuesList);
        break;
      case "properties":
        if (fieldSpec.empty || !hasKey(fieldSpec, "fields")) break;
        await readProperties(env, fieldName, fieldSpec, valuesList);
        break;
      default:
        break;
    }
  }
}

/** models.py:388-414. */
async function readMany2one(env: Environment, field: FieldDef, fieldName: string, spec: FieldSpec, valuesList: RecordValues[]): Promise<void> {
  if (!hasKey(spec, "fields") || spec.fields === undefined) return; // bare id stays (load='web')
  const comodel = field.relation;
  if (comodel === null) throw new NotPorted(`many2one ${fieldName} without comodel`);
  const coIds: number[] = [];
  const seen = new Set<number>();
  for (const values of valuesList) {
    const v = values[fieldName];
    if (typeof v === "number" && !seen.has(v)) {
      seen.add(v);
      coIds.push(v);
    }
  }
  const coEnv = withSubContext(env, spec.context);
  const { display_name: _dn, ...extraFields } = spec.fields;
  const data = new Map<number, RecordValues>();
  for (const vals of await webRead(coEnv, comodel, coIds, extraFields)) data.set(idOf(vals), vals);
  if ("display_name" in spec.fields) {
    // models.py:406: `rec.sudo().display_name` on the (context-bearing) co-records
    const names = await displayNamesOrFalse(coEnv, comodel, coIds);
    for (const id of coIds) {
      const vals = data.get(id);
      if (vals !== undefined) vals["display_name"] = names.get(id) ?? false;
    }
  }
  for (const values of valuesList) {
    const v = values[fieldName];
    if (v === false) continue;
    if (typeof v !== "number") throw new NotPorted(`read() of many2one ${fieldName} returned ${JSON.stringify(v)} (expected load='web' ids)`);
    const vals = data.get(v);
    if (vals === undefined) throw new NotPorted(`web_read: comodel ${comodel} did not return record ${v} for ${fieldName}`);
    values[fieldName] = vals;
  }
}

/** models.py:416-454. */
async function readX2many(env: Environment, field: FieldDef, fieldName: string, spec: FieldSpec, valuesList: RecordValues[]): Promise<void> {
  if (spec.empty) return;
  const comodel = field.relation;
  if (comodel === null) throw new NotPorted(`x2many ${fieldName} without comodel`);
  // `self[field_name]`: the union of the co-records in order of appearance
  const union: number[] = [];
  const seen = new Set<number>();
  for (const values of valuesList) {
    for (const id of idList(values[fieldName], fieldName)) {
      if (!seen.has(id)) {
        seen.add(id);
        union.push(id);
      }
    }
  }
  let coIds = union;
  if (hasKey(spec, "order") && spec.order !== null && spec.order !== undefined && spec.order !== "") {
    // models.py:421: re-order through a search with active_test=False, then keep only the found ids
    const ordered = await env.withContext({ ...env.context, active_test: false }).model(comodel)
      .search(cond("id", "in", union), { order: spec.order });
    const orderKey = new Map<number, number>();
    ordered.forEach((id, i) => orderKey.set(id, i));
    for (const values of valuesList) {
      const kept = idList(values[fieldName], fieldName).filter((id) => orderKey.has(id));
      kept.sort((a, b) => (orderKey.get(a) ?? 0) - (orderKey.get(b) ?? 0));
      values[fieldName] = kept;
    }
    coIds = ordered;
  }
  const coEnv = withSubContext(env, spec.context);
  if (!hasKey(spec, "fields") || spec.fields === undefined) return;
  if (spec.limit !== null && spec.limit !== undefined) {
    // models.py:438: only the first `limit` ids of every record are read; the rest stay `{id}`
    const toRead: number[] = [];
    const seenRead = new Set<number>();
    for (const values of valuesList) {
      for (const id of idList(values[fieldName], fieldName).slice(0, spec.limit)) {
        if (!seenRead.has(id)) {
          seenRead.add(id);
          toRead.push(id);
        }
      }
    }
    coIds = toRead;
  }
  const data = new Map<number, RecordValues>();
  for (const vals of await webRead(coEnv, comodel, coIds, spec.fields)) data.set(idOf(vals), vals);
  for (const values of valuesList) {
    values[fieldName] = idList(values[fieldName], fieldName).map((id) => data.get(id) ?? { id });
  }
}

/** models.py:507-530: follow many2one/many2many property values into their comodel. */
async function readProperties(env: Environment, fieldName: string, spec: FieldSpec, valuesList: RecordValues[]): Promise<void> {
  const subSpecs = spec.fields ?? {};
  const coEnv = spec.context === undefined ? env : env.withContext(spec.context);
  for (const values of valuesList) {
    const old = values[fieldName];
    if (!Array.isArray(old)) throw new NotPorted(`read() of properties ${fieldName} returned ${JSON.stringify(old)}`);
    const next: unknown[] = [];
    for (const [propertyName, sub] of Object.entries(subSpecs)) {
      const property = old.find((p): p is Record<string, unknown> => isRecord(p) && p["name"] === propertyName);
      if (property === undefined) continue;
      const type = property["type"];
      const comodel = property["comodel"];
      const value = property["value"];
      if (typeof comodel === "string" && value !== false && value !== null && value !== undefined && hasKey(sub, "fields") && sub.fields !== undefined) {
        if (type === "many2one" && Array.isArray(value) && typeof value[0] === "number") {
          property["value"] = await webRead(coEnv, comodel, [value[0]], sub.fields);
        } else if (type === "many2many" && Array.isArray(value)) {
          const ids = value.map((r: unknown) => (Array.isArray(r) && typeof r[0] === "number" ? r[0] : null))
            .filter((x): x is number => x !== null);
          property["value"] = await webRead(coEnv, comodel, ids, sub.fields);
        }
      }
      next.push(property);
    }
    values[fieldName] = next;
  }
}

registerBaseMethod("web_read", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "web_read");
  // the dispatcher strips the ids from args (methods.ts callKw), so the specification is args[0]
  const spec = parseSpecification(kwargs["specification"] ?? args[0]);
  return webRead(env, model, recIds, spec);
}, { apiModel: false, readonly: true });

/** models.py:458-512: reference / many2one_reference values with a sub-specification. */
async function readReference(env: Environment, model: string, field: FieldDef, fieldName: string, spec: FieldSpec, valuesList: RecordValues[]): Promise<void> {
  for (const values of valuesList) {
    const raw = values[fieldName];
    if (!raw) continue;
    let coModel: string, coId: number;
    if (field.type === "reference") {
      if (typeof raw !== "string" || !raw.includes(",")) throw new NotPorted(`reference value ${String(raw)} of ${model}.${fieldName}`);
      const i = raw.lastIndexOf(",");
      coModel = raw.slice(0, i); coId = Number(raw.slice(i + 1));
    } else {
      if (!field.modelField) throw new NotPorted(`many2one_reference ${model}.${fieldName} without model_field`);
      const id = idOf(values);
      const [row] = await env.sudo().model(model).read([id], [field.modelField], "");
      const m = row?.[field.modelField];
      if (!m) { values[fieldName] = false; continue; }
      coModel = String(m); coId = Number(raw);
    }
    if (!env.reg.models.has(coModel)) throw new NotPorted(`reference to unknown model ${coModel}`);
    const coEnv = withSubContext(env, spec.context);
    const exists = async (): Promise<boolean> =>
      (await coEnv.sudo().withContext({ ...coEnv.context, active_test: false }).model(coModel).search(cond("id", "=", coId), { activeTest: false })).length > 0;
    let referenceRead: RecordValues[] | null = null;
    let coExists: boolean;
    if (hasKey(spec, "fields") && spec.fields !== undefined) {
      try {
        referenceRead = await webRead(coEnv, coModel, [coId], spec.fields);
      } catch (e) {
        if (!(e instanceof AccessError)) throw e;
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated "You don't have access to this record" (${env.lang})`);
        referenceRead = [{ id: coId, display_name: "You don't have access to this record" }];
      }
      coExists = Object.keys(spec.fields).some((f) => f !== "id") ? referenceRead.length > 0 : await exists();
    } else {
      coExists = await exists();
    }
    if (!coExists) {
      values[fieldName] = false;
      if (field.type === "many2one_reference" && field.modelField) values[field.modelField] = false;
      continue;
    }
    if (referenceRead !== null) {
      const v: RecordValues = { ...referenceRead[0] };
      if (field.type === "reference") v["id"] = { id: coId, model: coModel };
      values[fieldName] = v;
    }
  }
}
