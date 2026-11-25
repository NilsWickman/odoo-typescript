/**
 * `BaseModel.create` (odoo/odoo/orm/models.py:4088-4345), `_prepare_create_values` (:4295), `_create` (:4347-4450),
 * `_parent_store_create` (:4460). Python overrides of a model (src/models/*_write.ts) wrap the core through
 * `registerOverrides`; mail.thread-like side effects run through `hooksOf(model).write` (src/orm/hooks.ts).
 */
import { noteCreated } from "./created";
import { NotPorted, OdooError } from "../errors";
import { defaultGet } from "../web/defaults";
import { checkModelAccess } from "./access";
import { OdooValueError, parseCommands } from "./commands";
import { convertToCache, convertToColumn, floatRound, referenceValue } from "./convert";
import { isPyFloat, pyFloat } from "./values";
import { normalizeValsList } from "./compiled_vals";
import { dumps } from "../http/json";
import { hooksOf } from "./hooks";
import { ModelImpl } from "./model";
import { insertColumn, writeValue } from "./write_values";
import { emptyValue, invalidationPoint, isComputed, NewRec, noteDeferredCreate, noteWindowCreate, RecomputeQueue, recordCompute } from "./recompute";
import { createProcessedImage, IMAGE_MIXIN_SIZES, isImageMixinSource, isProcessedImage, processedImageRelated, writeImageMixin } from "./image_write";
import { checkFieldAccess, companyDependentFallback, ident, runSql, sql, Sql } from "./sql";
import type { Environment, FieldDef, ModelDef } from "./types";
import { genPrecompute } from "./genmeta";
import { registryLoading } from "./signaling";
import { checkCompany, checkCompanyAuto } from "./check_company";
import { writeX2many, overridesOf, runInverses, validateFields, inverseFields, write } from "./write";

export const LOG_ACCESS_COLUMNS = ["create_uid", "create_date", "write_uid", "write_date"];

/**
 * Fields with `precompute=True` (models.py:4302 `_add_precomputed_values`), generated from the registry by
 * gen/precompute.py (gen/out[/<template>]/precompute.json): every one of them, so none is left to a recompute after
 * the INSERT (a required one fails there, a non-required one is stored empty: sale.order.line.tax_ids).
 */
export async function precomputed(env: Environment, model: string): Promise<readonly string[]> {
  return (await genPrecompute(env, model))?.fields ?? [];
}

/** The public `create(vals_list)`: hooks (mail.thread), model overrides, then the ORM core. Returns the new ids. */
export async function create(env: Environment, model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
  if (!valsList.length) return [];
  // values from compiled code in the RPC layer's form before any hook reads them (orm/compiled_vals.ts)
  normalizeValsList(env, model, valsList);
  // ir.default and ir.access `invalidate_all` (src/orm/recompute.ts `invalidationPoint`)
  await invalidationPoint(env, model, "create", "before");
  const ids = await createInner(env, model, valsList);
  await invalidationPoint(env, model, "create", "after");
  return ids;
}

async function createInner(env: Environment, model: string, valsList: Record<string, unknown>[]): Promise<number[]> {
  const hooks = hooksOf(model).write ?? [];
  const override = overridesOf(model).create;
  const withHooks = async (e: Environment, v: Record<string, unknown>[]): Promise<number[]> => {
    for (const h of hooks) if (h.beforeCreate) await h.beforeCreate(e, v);
    const ids = await createCore(e, model, v);
    for (const h of hooks) if (h.afterCreate) await h.afterCreate(e, ids, v);
    return ids;
  };
  // a model whose override sits above mail.thread in the MRO and does more than wrap it (res.company: the
  // modules' per-company records come after the creation message) gets the hooks inside its `next`
  if (override && (HOOKS_INSIDE.has(model) || await hooksInsideFor(env, model))) return override(env, valsList, withHooks);
  // Odoo logs the tracking of a write at precommit (mail_track_mixin.py:91), so a write the create makes on other
  // records of the model (res.partner `_fields_sync` writing the parent, res_partner.py:884-906) is logged after the
  // create's own messages ("Contact created"): the create keeps a tracking level of the model open around them
  const scope = hooks.length > 0 && override ? await openTrackingLevel(env, model) : null;
  let ids: number[];
  try {
    for (const h of hooks) if (h.beforeCreate) await h.beforeCreate(env, valsList);
    ids = override ? await override(env, valsList, (e, v) => createCore(e, model, v)) : await createCore(env, model, valsList);
    for (const h of hooks) if (h.afterCreate) await h.afterCreate(env, ids, valsList);
  } catch (e) {
    if (scope) scope.abort();
    throw e;
  }
  if (scope) await scope.close();
  return ids;
}

/** Open a tracking level of `model` (snapshotting nothing) and return its closing, or null when it tracks nothing. */
async function openTrackingLevel(env: Environment, model: string): Promise<{ close: () => Promise<void>; abort: () => void } | null> {
  const tracking = await import("../mail/tracking");
  if (!(await tracking.trackedFields(env, model)).length) return null;
  await tracking.trackPrepare(env, model, []);
  return {
    close: async () => {
      const { closeTrackingScope } = await import("../mail/write_hooks");
      await closeTrackingScope(env, model);
    },
    abort: () => tracking.trackAbortLevel(env.cr, model),
  };
}

/** Models whose create override runs the mail.thread hooks inside `next` (see `create`). */
export const HOOKS_INSIDE = new Set<string>();

/**
 * Models whose create hooks go inside the override's `next` only where a site's compiled create override serves the
 * database (compiler/runtime/install.ts overrideKey: its chain lies wholly above mail.thread). purchase.order: the hand
 * port's override has the hooks outside; purchase_requisition's compiled create sits above mail.thread in Odoo's MRO,
 * so "Purchase Order created" is posted inside its super(), before the origin link it posts after (parent_id).
 */
const HOOKS_INSIDE_WHEN = new Map<string, ((env: Environment) => Promise<boolean>)[]>();
export function hooksInsideWhen(model: string, fn: (env: Environment) => Promise<boolean>): void {
  HOOKS_INSIDE_WHEN.set(model, [...(HOOKS_INSIDE_WHEN.get(model) ?? []), fn]);
}
async function hooksInsideFor(env: Environment, model: string): Promise<boolean> {
  for (const fn of HOOKS_INSIDE_WHEN.get(model) ?? []) if (await fn(env)) return true;
  return false;
}

/** The models inheriting analytic.mixin in the templates (gen/out/poc_erp/models.json `inherit`). */
const ANALYTIC_MIXIN = new Set(["account.analytic.distribution.model", "account.move.line", "account.reconcile.model.line", "purchase.order.line", "sale.order.line"]);

/**
 * analytic_mixin.py:169-205 create/write `_sanitize_values`: every share of `analytic_distribution` (except the
 * `__update__` key) is `float_round(value, 'Percentage Analytic' digits)`, a Python float (stored "100.0", not "100").
 */
export async function sanitizeAnalytic(env: Environment, model: string, vals: Record<string, unknown>): Promise<void> {
  if (!ANALYTIC_MIXIN.has(model) || !("analytic_distribution" in vals)) return;
  const d = vals["analytic_distribution"];
  if (!d || typeof d !== "object" || Array.isArray(d) || isPyFloat(d)) return; // `vals.get(...) and {...}`: falsy stays
  const digits = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = 'Percentage Analytic'")).rows[0]?.digits ?? 2;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
    const n = isPyFloat(v) ? v.float : v;
    if (k === "__update__") out[k] = v;
    else if (typeof n === "number") out[k] = pyFloat(floatRound(n, digits));
    else throw new NotPorted(`analytic_distribution share ${JSON.stringify(v)}`);
  }
  vals["analytic_distribution"] = out;
}

/** The column text of a sanitized analytic distribution (src/models/account_move_create.ts writes its lines itself). */
export async function sanitizedAnalyticJson(env: Environment, value: unknown): Promise<string> {
  const vals: Record<string, unknown> = { analytic_distribution: value };
  await sanitizeAnalytic(env, "account.move.line", vals);
  return dumps(vals["analytic_distribution"]);
}

/** models.py:4088 BaseModel.create. */
export async function createCore(env: Environment, model: string, valsListIn: Record<string, unknown>[]): Promise<number[]> {
  const def = env.reg.model(model);
  if (def.abstract) throw new NotPorted(`create on abstract model ${model}`);
  if (!env.su) await checkModelAccess(env, def, "create");
  // models.py:4119-4134: every given field, and the fields with a default_ context key, must be writable
  const names = new Set<string>();
  for (const vals of valsListIn) for (const k of Object.keys(vals)) names.add(k);
  for (const key of Object.keys(env.context)) if (key.startsWith("default_") && def.fields.has(key.slice(8))) names.add(key.slice(8));
  for (const name of names) {
    const field = def.fields.get(name);
    if (!field) throw new OdooValueError(`Invalid field '${name}' in '${model}'`);
    await checkFieldAccess(env, def, field, "write");
  }
  for (const vals of valsListIn) await sanitizeAnalytic(env, model, vals);
  const valsList = await prepareCreateValues(env, def, valsListIn);
  const inverses = await inverseFields(env, model);
  const preFields = await precomputed(env, model);

  // models.py:4140-4182: split stored / inversed / cached-only values, collect protected fields
  interface Data { stored: Record<string, unknown>; inversed: Record<string, unknown>; protectedFields: Set<string>; inherited: Map<string, Record<string, unknown>> }
  const dataList: Data[] = valsList.map((vals) => {
    const inherited = new Map<string, Record<string, unknown>>();
    const stored: Record<string, unknown> = {};
    const inversed: Record<string, unknown> = {};
    const protectedFields = new Set<string>();
    for (const [key, val] of Object.entries(vals)) {
      if (key === "__precomputed__") continue;
      const field = def.fields.get(key);
      if (!field) throw new OdooValueError(`Invalid field '${key}' on model '${model}'`);
      if (field.store && !field.inheritedFrom) stored[key] = val;
      if (field.inheritedFrom) {
        const pv = inherited.get(field.inheritedFrom) ?? {};
        pv[key] = val;
        inherited.set(field.inheritedFrom, pv);
        continue;
      }
      const pre = (vals["__precomputed__"] as Set<string> | undefined)?.has(key) ?? false;
      if (inverses.has(key) && !pre) inversed[key] = val;
      // cached-only values (not stored, not computed) only live in the cache of the new record: nothing to store
      if (isComputed(field) && (!field.readonly || preFields.includes(key))) {
        for (const f of coComputed(def, field)) protectedFields.add(f);
      }
    }
    // image.mixin: the sizes of a given image_1920 are stored with it below (writeImageMixin), not by the queue
    const image = def.fields.get("image_1920");
    if (vals["image_1920"] && image && isImageMixinSource(def, image)) {
      for (const size of Object.keys(IMAGE_MIXIN_SIZES)) if (size !== "image_1920") protectedFields.add(size);
    }
    // the same for a processed Image field's stored related images (createProcessedImage)
    for (const f of processedImageRelated(def, vals)) protectedFields.add(f);
    return { stored, inversed, protectedFields, inherited };
  });

  // models.py:4190-4209 `_inherits`: create the parents of the records without one, write the given parents
  for (const [parentModel, link] of def.inherits) {
    const toCreate = dataList.filter((d) => !d.stored[link]);
    for (const d of dataList) {
      const pv = d.inherited.get(parentModel);
      if (d.stored[link] && pv && Object.keys(pv).length) await write(env, parentModel, [Number(d.stored[link])], pv);
    }
    if (toCreate.length) {
      const parents = await create(env, parentModel, toCreate.map((d) => ({ ...(d.inherited.get(parentModel) ?? {}) })));
      toCreate.forEach((d, i) => { d.stored[link] = parents[i]; });
    }
  }

  // models.py:4347 _create: INSERT the column values
  const lang = env.lang ?? "en_US";
  const ids: number[] = [];
  const others = new Set<string>();
  const rows: { columns: string[]; values: Sql[] }[] = [];
  for (const data of dataList) {
    const columns: string[] = [];
    const values: Sql[] = [];
    for (const fname of Object.keys(data.stored).sort()) {
      const field = def.fields.get(fname)!;
      if (field.column) {
        columns.push(fname);
        const v = data.stored[fname];
        if (LOG_ACCESS_COLUMNS.includes(fname) && v === NOW) values.push(sql`(now() AT TIME ZONE 'UTC')`);
        else if (field.companyDependent || field.translate || field.type === "monetary" || field.type === "html") {
          const cache = await writeValue(env, def, field, v, data.stored, null);
          const col = await insertColumn(env, def, field, cache);
          values.push(col.jsonb && col.value !== null ? sql`${col.value}::jsonb` : sql`${col.value}`);
        } else {
          const cache = convertToCache(field, field.type === "reference" ? await referenceValue(env, v) : v, model);
          const col = convertToColumn(field, cache, lang);
          values.push(field.type === "json" && col !== null ? sql`${col}::jsonb` : sql`${col}`);
        }
      } else {
        others.add(fname);
      }
    }
    rows.push({ columns, values });
  }
  if (rows.length === 1) {
    const { columns, values } = rows[0]!;
    const text = columns.length
      ? sql`INSERT INTO ${ident(def.table)} (${Sql.join(", ", columns.map((c) => ident(c)))}) VALUES (${Sql.join(", ", values)}) RETURNING id`
      : sql`INSERT INTO ${ident(def.table)} DEFAULT VALUES RETURNING id`;
    const [row] = await runSql<{ id: number }>(env, text);
    ids.push(row!.id);
  } else {
    // models.py:4347-4378 `_create`: the records in one INSERT per INSERT_BATCH_SIZE (100), on the union of their
    // columns (sorted) and DEFAULT where a record has no value; without any column, `id` with DEFAULT
    for (let at = 0; at < rows.length; at += 100) {
      const batch = rows.slice(at, at + 100);
      const names = [...new Set(batch.flatMap((r) => r.columns))].sort();
      const columns = names.length ? names : ["id"];
      const tuples = batch.map((r) => sql`(${Sql.join(", ", columns.map((c) => {
        const i = r.columns.indexOf(c);
        return i < 0 ? sql`DEFAULT` : r.values[i]!;
      }))})`);
      const returned = await runSql<{ id: number }>(env, sql`INSERT INTO ${ident(def.table)} (${Sql.join(", ", columns.map((c) => ident(c)))}) VALUES ${Sql.join(", ", tuples)} RETURNING id`);
      if (returned.length !== batch.length) throw new TypeError(`INSERT INTO ${def.table} returned ${returned.length} ids for ${batch.length} records`);
      for (const r of returned) ids.push(r.id);
    }
  }

  noteCreated(env.cr, model, ids);
  await parentStoreCreate(env, def, ids);

  // models.py:4428-4442: non-column stored fields (x2many, attachments), then modified(all fields, create=True)
  const queue = new RecomputeQueue(env);
  queue.markCreated(model, ids);
  {
    // the records Odoo leaves with a pending stored compute after the INSERT (src/orm/recompute.ts deferredFlush)
    const pending = [...def.fields.values()].filter((f) => f.store && isComputed(f) && f.type !== "one2many" && !preFields.includes(f.name));
    const withPending = ids.map((id, i) => [id, pending.filter((f) => !(f.name in valsListIn[i]!) && !dataList[i]!.protectedFields.has(f.name)).map((f) => f.name)] as const)
      .filter(([, fields]) => fields.length);
    if (withPending.length) noteDeferredCreate(env, model, withPending);
    // the fields those records have dirty in Odoo's cache after the create: those computes, and the company-dependent
    // columns behind a non-stored computed field, which its inverse writes (account.account's code -> code_store, the
    // code given or made from `prefix` by account_account.py create)
    const dirty = new Set(pending.filter((f) => valsListIn.some((v, i) => !(f.name in v) && !dataList[i]!.protectedFields.has(f.name))).map((f) => f.name));
    for (const g of def.fields.values()) {
      if (g.store || !isComputed(g)) continue;
      for (const dep of g.depends) {
        const f = def.fields.get(dep);
        if (f?.store && f.companyDependent) dirty.add(f.name);
      }
    }
    noteWindowCreate(env, model, dirty);
  }
  dataList.forEach((data, i) => queue.protect(model, data.protectedFields, [ids[i]!]));
  // models.py:4380-4396 and :4196-4226: the given computed fields stay protected while the x2many records are created
  // and the inverse methods run, for the nested creates and writes too (`env.protecting`)
  await queue.protecting(() => queue.readable(async () => {
  // models.py:4430-4431 `records.modified(self._fields, create=True)` before the x2many lines are created: their
  // computes read the new records' marked fields on access (RecomputeQueue.readable)
  await queue.modified(model, ids, def.fields.keys());
  for (const fname of await updateOrder(env, def, [...others])) {
    const field = def.fields.get(fname)!;
    for (let i = 0; i < ids.length; i++) {
      if (!(fname in dataList[i]!.stored)) continue;
      const value = dataList[i]!.stored[fname];
      if (field.type === "one2many" || field.type === "many2many") {
        await writeX2many(env, def, field, [ids[i]!], parseCommands(value, `${model}.${fname}`), true);
      } else if ((field.type === "binary" || field.type === "image") && !value) {
        continue;
      } else if (field.name === "image_1920" && isImageMixinSource(def, field)) {
        // image.mixin: the attachments of image_1920 and its sizes, as a write stores them (src/orm/image_write.ts);
        // the queue's related sizes then find their value in place
        await writeImageMixin(env, def, [ids[i]!], value, true);
      } else if ((field.type === "binary" || field.type === "image") && isProcessedImage(def, field)) {
        await createProcessedImage(env, def, field, ids[i]!, value);
      } else {
        throw new NotPorted(`create of non-column field ${model}.${fname}`);
      }
    }
  }
  await queue.modified(model, ids, def.fields.keys());
  await queue.run();

  // models.py:4211-4240: inverse methods of the inversed fields
  for (let i = 0; i < ids.length; i++) {
    const inversed = dataList[i]!.inversed;
    // a related field's inverse assigns the value along its path (fields.py:799-813), the generic write does that
    const related = Object.keys(inversed).filter((n) => {
      const f = def.fields.get(n);
      return f && !f.store && f.related && !f.readonly && !f.inheritedFrom && !overridesOf(model).inverse?.[n];
    });
    for (const n of related) await write(env, model, [ids[i]!], { [n]: inversed[n] });
    const inv = Object.keys(inversed).filter((n) => !related.includes(n));
    if (inv.length) await runInverses(env, def, [ids[i]!], inv, inversed);
  }
  }));

  // models.py:4246: constraints of the stored (and inversed) fields
  for (let i = 0; i < ids.length; i++) {
    await validateFields(env, def, [ids[i]!], [...Object.keys(dataList[i]!.inversed), ...Object.keys(dataList[i]!.stored)]);
  }
  // models.py:4448 records.check_access('create')
  await new ModelImpl(env, def).checkAccess(ids, "create");
  // models.py:4232-4233 `_check_company()` of the models with `_check_company_auto`
  if (await checkCompanyAuto(env, model)) await checkCompany(env, def, ids, null);
  return ids;
}

/**
 * models.py:4437 the non-column fields of a create in `_fields_update_order__` (model_classes.py:346-349: the field
 * class's `write_sequence`, x2many 20 (fields_relational.py:589), monetary and properties 10, others 0; then the
 * `_fields` index of src/models/field_order_*.json). Fields missing from that order keep the name order.
 */
/**
 * x2many fields whose value the port gives as a default where Odoo computes it (a stored compute that fills an empty
 * field, run at the recompute after every record's x2many commands): written after the other x2many fields, in the
 * order given (account.tax: the invoice lines, then the refund lines, account_tax.py:438-454).
 */
const COMPUTED_LAST = new Map<string, readonly string[]>();
export function registerComputedX2manyLast(model: string, fields: readonly string[]): void {
  COMPUTED_LAST.set(model, fields);
}

async function updateOrder(env: Environment, def: ModelDef, names0: string[]): Promise<string[]> {
  const last = (COMPUTED_LAST.get(def.name) ?? []).filter((n) => names0.includes(n));
  return [...(await updateOrderOf(env, def, names0.filter((n) => !last.includes(n)))), ...last];
}

async function updateOrderOf(env: Environment, def: ModelDef, names: string[]): Promise<string[]> {
  if (names.length < 2) return names;
  const { fieldOrder } = await import("../models/base_import");
  const order = (await fieldOrder(env))[def.name];
  if (!order || names.some((n) => !order.includes(n))) return names;
  const seq = (n: string): number => {
    const t = def.fields.get(n)!.type;
    return t === "one2many" || t === "many2many" ? 20 : t === "monetary" || t === "properties" ? 10 : 0;
  };
  return [...names].sort((a, b) => seq(a) - seq(b) || order.indexOf(a) - order.indexOf(b));
}

/** Fields computed by the same method (`pool.field_computed`): street_name/street_number/street_number2. */
export function coComputed(def: ModelDef, field: FieldDef): string[] {
  const group = CO_COMPUTED[def.name]?.find((g) => g.includes(field.name));
  return group ? [...group] : [field.name];
}

const CO_COMPUTED: Readonly<Record<string, readonly (readonly string[])[]>> = {
  // base_address_extended/models/res_partner.py:10-15 one compute `_compute_street_data`
  "res.partner": [["street_name", "street_number", "street_number2"]],
  // purchase_order_line.py:545-606 one compute `_compute_price_unit_and_date_planned_and_name`
  "purchase.order.line": [["name", "date_planned", "discount", "price_unit", "technical_price_unit"]],
  // base ir_actions.py:828 `_compute_name`, :848 `_compute_crud_relations`; mail ir_actions_server.py:193 `_compute_followers_info`
  // crm crm_lead.py:218-221 one compute `_compute_probabilities`: a given probability leaves automated_probability as
  // it was (NULL on a create)
  "crm.lead": [["probability", "automated_probability"]],
  "ir.actions.server": [["name", "automated_name"], ["crud_model_id", "update_field_id", "update_property", "update_related_model_id"],
    ["followers_partner_field_name", "partner_ids"]],
};

/** Marker for `cr.now()` values of log access columns (rendered as the database clock in SQL). */
export const NOW: unique symbol = Symbol("cr.now()");

/** models.py:4295 _prepare_create_values: defaults, magic fields, precomputed fields. */
async function prepareCreateValues(env: Environment, def: ModelDef, valsList: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
  // models.py:4269-4273: the superuser may set the log access fields while the registry loads (a module's data, the
  // chart loader's demo activities with their `create_uid`, account_demo.py:524-562)
  const logGiven = env.uid === 1 && registryLoading(env.cr);
  const bad = new Set(["id", "parent_path", ...(def.logAccess && !logGiven ? LOG_ACCESS_COLUMNS : [])]);
  const out: Record<string, unknown>[] = [];
  for (const vals0 of valsList) {
    const vals = await addMissingDefaultValues(env, def, vals0);
    for (const b of bad) delete vals[b];
    if (def.logAccess) {
      if (logGiven && LOG_ACCESS_COLUMNS.some((c) => c in vals && (c === "create_date" || c === "write_date"))) throw new NotPorted(`${def.name} created with a given create_date or write_date`);
      vals["create_uid"] ??= env.uid; vals["create_date"] = NOW; vals["write_uid"] ??= env.uid; vals["write_date"] = NOW;
    }
    out.push(vals);
  }
  // models.py:4302-4345 _add_precomputed_values
  const gen = await genPrecompute(env, def.name);
  if (gen?.fields.length) {
    // :4314-4319 several fields with the same compute: setting one of them leaves the others False
    for (const vals of out) {
      for (const group of gen.groups) if (group.some((f) => f in vals)) for (const f of group) if (!(f in vals)) vals[f] = false;
    }
    for (const vals of out) {
      const missing = gen.fields.filter((f) => !(f in vals));
      if (!missing.length) continue;
      // :4330 `self.new(vals)`: values go to the cache without validation (no html_sanitize, models.py new())
      const rec = new NewRec(env, def, null);
      for (const [k, v] of Object.entries(vals)) {
        const f = def.fields.get(k);
        if (!f || v === NOW) continue;
        // an attachment binary (image.mixin's image_1920) or a non-stored one (product.product's image_1920, given to its
        // inverse) is not read by the precomputes; one that depends on it refuses
        if ((f.type === "binary" || f.type === "image") && (f.attachment || !f.store) && v) {
          if (missing.some((m) => def.fields.get(m)?.depends.some((d) => d.split(".")[0] === k))) throw new NotPorted(`precompute of ${def.name} depending on ${k}`);
          continue;
        }
        if (f.type === "one2many" || f.type === "many2many") rec.put(k, x2manyCache(v));
        else rec.put(k, f.type === "html" ? (v === false || v === null || v === undefined ? null : String(v)) : convertToCache(f, v, def.name));
      }
      const done = new Set<string>();
      for (const fname of missing) {
        const field = def.fields.get(fname)!;
        // :4339-4342 `record[fname]` (sudo for compute_sudo): computeValue runs the ported compute or the related
        // traversal and raises NotPorted for a compute that is not ported, never an empty value
        if (!isComputed(field)) throw new NotPorted(`precompute ${def.name}.${fname} without a compute`);
        const value = await rec.get(fname);
        vals[fname] = toWrite(field, value);
        done.add(fname);
      }
      vals["__precomputed__"] = done;
    }
  }
  if (def.name === "sale.order.line") {
    // sale/models/sale_order_line.py:1825-1829 _add_precomputed_values: the technical price follows the unit price
    for (const vals of out) if ("price_unit" in vals && !("technical_price_unit" in vals)) vals["technical_price_unit"] = vals["price_unit"];
  }
  return out;
}

/**
 * The cache value of x2many commands in `new(vals)`: ids for links ([6, 0, ids], [4, id], plain ids), [] for [5];
 * commands creating or updating lines stay as they are, which `NewRec.rels` refuses (a new line is not ported here),
 * so a precompute reading them fails loudly instead of seeing no lines.
 */
function x2manyCache(value: unknown): unknown {
  if (!Array.isArray(value)) return [];
  const ids: number[] = [];
  for (const cmd of value) {
    if (typeof cmd === "number") ids.push(cmd);
    else if (Array.isArray(cmd) && cmd[0] === 6) { ids.length = 0; ids.push(...((cmd[2] as number[] | undefined) ?? [])); }
    else if (Array.isArray(cmd) && cmd[0] === 4) ids.push(Number(cmd[1]));
    else if (Array.isArray(cmd) && cmd[0] === 5) ids.length = 0;
    else return value;
  }
  return ids;
}

/** `convert_to_write` of a cache value. */
export function toWrite(field: FieldDef, value: unknown): unknown {
  if (value === null || value === undefined) return field.type === "integer" ? 0 : field.type === "float" ? 0 : false;
  if (field.type === "one2many" || field.type === "many2many") return [[6, 0, value]];
  if (typeof value === "object" && "id" in (value as object) && field.type === "many2one") return (value as { id: unknown }).id ?? false;
  return value;
}

/** models.py:1625 _add_missing_default_values. */
export async function addMissingDefaultValues(env: Environment, def: ModelDef, values: Record<string, unknown>): Promise<Record<string, unknown>> {
  // models.py:1627-1646: inherited fields are not defaulted when their parent link is given (any ancestor)
  const avoid = new Set<string>();
  for (const [parentModel, link] of def.inherits) if (link in values) avoid.add(parentModel);
  if ([...def.inherits.values()].some((l) => !(l in values)) && def.inherits.size) {
    for (const parentModel of def.inherits.keys()) {
      const pdef = def ? env.reg.model(parentModel) : null;
      if (pdef && pdef.inherits.size) throw new NotPorted(`nested _inherits defaults (${def.name} -> ${parentModel})`);
    }
  }
  const missing = [...def.fields.keys()].filter((name) => !(name in values) && !(def.fields.get(name)!.inheritedFrom && avoid.has(def.fields.get(name)!.inheritedFrom!)));
  const defaults = missing.length ? await defaultGet(env, def.name, missing) : {};
  for (const [name, value] of Object.entries(defaults)) {
    const f = def.fields.get(name);
    if (f?.type === "many2many" && Array.isArray(value) && value.length && typeof value[0] === "number") defaults[name] = [[6, 0, value]];
  }
  return { ...defaults, ...values };
}

/** models.py:4460 _parent_store_create. */
async function parentStoreCreate(env: Environment, def: ModelDef, ids: readonly number[]): Promise<void> {
  if (!def.parentStore || !ids.length) return;
  const t = ident(def.table), p = ident(def.parentName);
  await runSql(env, sql`UPDATE ${t} node SET parent_path=concat((SELECT parent.parent_path FROM ${t} parent WHERE parent.id=node.${p}), node.id, '/') WHERE node.id = ANY(${[...ids]}::int[])`);
}

/** Read the current cache value of a stored field (helper for overrides). */
export async function currentValue(env: Environment, def: ModelDef, id: number, field: string): Promise<unknown> {
  const f = def.fields.get(field)!;
  return (await new ModelImpl(env.sudo(), def).values([id], f)).get(id) ?? emptyValue(f);
}

export { OdooError };
