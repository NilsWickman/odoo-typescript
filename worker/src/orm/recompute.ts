/**
 * Records as compute bodies see them (`self` of an `@api.depends` method), stored-compute recomputation after
 * create/write (`modified` + the recompute queue, odoo/odoo/orm/models.py:6269, fields.py `compute_value`), and the
 * registry of record-level computes and onchange methods hand-ported per model (src/models/*_write.ts).
 *
 * A record is either a database record (`DbRec`, values read through `ModelImpl.values`) or a new record
 * (`NewRec`, onchange/precompute: values in memory, optionally with an origin database record, models.py `new()`).
 * Values are in the cache format of src/orm/convert.ts.
 */
import { inOrder } from "../in_order";
import { refuseOverriddenDisplayName } from "./display_override";
import { IMAGE_MIXIN_SIZES, imageRelatedProcess, isImageMixinSource, writeRecomputedAttachment } from "./image_write";
import { imageProcess } from "../image/wasm-process";
import { binaryBytes, PreciseDatetime } from "./values";
import { onFieldFlush } from "./flush_points";
import type { BinaryValue } from "./types";
import { MissingError, NotPorted } from "../errors";
import { pyFloatRepr } from "../http/json";
import * as D from "./domain";
import { ModelImpl } from "./model";
import { plainColumn } from "./prefetch";
import { ident, runSql, sql, Sql, sqlColumnType } from "./sql";
import type { Environment, FieldDef, ModelDef } from "./types";
import type { PendingValue } from "../pending_writes";
import { cacheEqual, convertToColumn, floatRepr, floatRound, roundMonetary } from "./convert";
import { hooksOf } from "./hooks";
import { CompanyValue, TranslationDict } from "./write_values";
import { keyed } from "./keys";
import { isRecordingWritten, markWritten } from "./written_fields";

export interface Rec {
  readonly env: Environment;
  readonly def: ModelDef;
  /** The database id, or null for a new record (`bool(NewId)` is False). */
  readonly id: number | null;
  /** `_origin.id`: the database id behind a new record, or the id itself. */
  readonly origin: number | null;
  get(name: string): Promise<unknown>;
  /** A many2one value as a record (`self.parent_id`), or null when empty. */
  rel(name: string): Promise<Rec | null>;
  /** x2many value as database records (new lines are not supported). */
  rels(name: string): Promise<Rec[]>;
  /** The value a compute body sees for its own field while computing it (the cache before recomputation). */
  prev(name: string): Promise<unknown>;
}

/** A record compute body: the value of one field for one record. */
export type RecordCompute = (env: Environment, rec: Rec) => Promise<unknown>;
/** An `@api.onchange` method: reads and assigns on the new record; may return a warning. */
export type RecordOnchange = (env: Environment, rec: NewRec) => Promise<{ title: string; message: string; type?: string } | void>;

const COMPUTES = new Map<string, Map<string, RecordCompute>>();
const ONCHANGES = new Map<string, { fields: readonly string[]; fn: RecordOnchange; name: string }[]>();
/** Python field defaults (`default=`), by model and field; `undefined` result means "no default". */
const DEFAULTS = new Map<string, Map<string, (env: Environment) => Promise<unknown>>>();
/** Models whose Python `default=` values were all ported (create/default_get refuse other models). */
const DEFAULTS_PORTED = new Set<string>();

/** A stored compute that assigns nothing for a record (a `for` loop skipping it): the column keeps its value, and a
 * new record's stays NULL (Odoo flushes only assigned values). */
export const NOT_ASSIGNED: unique symbol = Symbol("not assigned");

export function registerRecordCompute(model: string, computes: Record<string, RecordCompute>): void {
  const m = COMPUTES.get(model) ?? new Map<string, RecordCompute>();
  for (const [k, v] of Object.entries(computes)) m.set(k, keyed("recordCompute", model, k, v));
  COMPUTES.set(model, m);
}

export function recordCompute(model: string, field: string): RecordCompute | undefined {
  return COMPUTES.get(model)?.get(field);
}

/** Register `@api.onchange` methods in the order of the Python class (MRO order). */
export function registerOnchange(model: string, name: string, fields: readonly string[], fn: RecordOnchange): void {
  const list = ONCHANGES.get(model) ?? [];
  list.push({ fields, fn: keyed("onchange", model, name, fn), name });
  ONCHANGES.set(model, list);
}

/** The port's implementation of Odoo's onchange method `name` on `model` (src/orm/onchange_methods.ts picks which run). */
export function registeredOnchange(model: string, name: string): RecordOnchange | undefined {
  return (ONCHANGES.get(model) ?? []).find((m) => m.name === name)?.fn;
}

/** The registrations of `model` that name `field` (registration order). */
export function registeredFor(model: string, field: string): { fields: readonly string[]; fn: RecordOnchange; name: string }[] {
  return (ONCHANGES.get(model) ?? []).filter((m) => m.fields.includes(field));
}

/** Every registration (model, method name, fields), for the consistency test against gen/onchange_methods.py. */
export function allRegisteredOnchanges(): { model: string; name: string; fields: readonly string[] }[] {
  return [...ONCHANGES].flatMap(([model, list]) => list.map((m) => ({ model, name: m.name, fields: m.fields })));
}

/** Python `default=` of the fields of `model` (all of them: a model is registered once its defaults are ported). */
export function registerDefaults(model: string, defaults: Record<string, (env: Environment) => Promise<unknown>>): void {
  const m = DEFAULTS.get(model) ?? new Map<string, (env: Environment) => Promise<unknown>>();
  for (const [k, v] of Object.entries(defaults)) m.set(k, keyed("default", model, k, v));
  DEFAULTS.set(model, m);
  DEFAULTS_PORTED.add(model);
}

export function fieldDefault(model: string, field: string): ((env: Environment) => Promise<unknown>) | undefined {
  return DEFAULTS.get(model)?.get(field);
}

/**
 * Fields whose default comes from the model's `default_get` override and that only the template knows (a site's
 * res.config.settings fields of its new modules, src/models/settings_defaults.ts): a new record's unassigned field
 * asks default_get when the model's resolver says so, as for a registered default.
 */
const DEFAULT_RESOLVERS = new Map<string, (env: Environment, field: string) => Promise<boolean>>();
export function registerDefaultResolver(model: string, fn: (env: Environment, field: string) => Promise<boolean>): void {
  DEFAULT_RESOLVERS.set(model, fn);
}
export async function hasResolvedDefault(env: Environment, model: string, field: string): Promise<boolean> {
  const fn = DEFAULT_RESOLVERS.get(model);
  return fn ? fn(env, field) : false;
}

export function defaultsPorted(model: string): boolean {
  return DEFAULTS_PORTED.has(model);
}

/** Field.compute or related: the value comes from a compute body. */
export function isComputed(field: FieldDef): boolean {
  return field.compute || field.related !== null;
}

function fieldOf(def: ModelDef, name: string): FieldDef {
  const f = def.fields.get(name);
  if (!f) throw new NotPorted(`field ${def.name}.${name}`);
  return f;
}

/** fields.py:759 related traversal: `value[name][:1]` per step, the last field's value. */
async function relatedValue(rec: Rec, path: string): Promise<unknown> {
  const parts = path.split(".");
  let cur: Rec | null = rec;
  for (const part of parts.slice(0, -1)) {
    const f = fieldOf(cur.def, part);
    if (f.type === "many2one") cur = await cur.rel(part);
    else if (f.type === "one2many" || f.type === "many2many") cur = (await cur.rels(part))[0] ?? null;
    else throw new NotPorted(`related traversal ${rec.def.name}.${path}`);
    if (cur === null) return emptyValue(fieldOf(lastModel(rec, parts), parts[parts.length - 1]!));
  }
  return cur.get(parts[parts.length - 1]!);
}

function lastModel(rec: Rec, parts: string[]): ModelDef {
  let def = rec.def;
  for (const part of parts.slice(0, -1)) def = rec.env.reg.model(fieldOf(def, part).relation!);
  return def;
}

/** The cache value of an empty field (convert_to_cache(False)). */
export function emptyValue(field: FieldDef): unknown {
  switch (field.type) {
    case "boolean": return false;
    case "integer": return 0;
    case "float": case "monetary": return null;
    case "one2many": case "many2many": return [];
    default: return null;
  }
}

/** `model.field` of the computes that assign False to the whole recordset first (see `step`). */
const RESET_FIRST = new Set<string>();
export function registerResetFirst(model: string, fields: readonly string[]): void {
  for (const f of fields) RESET_FIRST.add(`${model}.${f}`);
}

async function computeValue(rec: Rec, field: FieldDef): Promise<unknown> {
  const fn = recordCompute(rec.def.name, field.name);
  if (fn) return fn(field.computeSudo || field.store ? rec.env.sudo() : rec.env, rec);
  if (field.related) {
    const value = await relatedValue(rec, field.related);
    // fields_binary.py:389-396 `_process_related` -> `_image_process` (image_mixin.py: the smaller sizes of image_1920)
    if ((field.type === "image" || field.type === "binary") && field.related === "image_1920" && field.name in IMAGE_MIXIN_SIZES
      && field.name !== "image_1920" && isImageMixinSource(rec.def, rec.def.fields.get("image_1920")!)) {
      if (value === null || value === false) return null;
      const size = IMAGE_MIXIN_SIZES[field.name]!;
      const bytes = await (value as BinaryValue).content();
      return binaryBytes(imageProcess(bytes, size, size));
    }
    // any other stored related Image field (fields_binary.py:389-396 `_process_related`; a readonly one related to an
    // Image field of its size keeps the value, fleet.vehicle.model.image_128 = brand_id.image_128). A non-stored one
    // (crm.team.member.image_128, res.users.image_128) is read as the value: Odoo's processing of it gives the same
    // bytes for an image it can decode (already within its size, or no size)
    if (field.image && field.store && (field.type === "image" || field.type === "binary")) {
      if (value === null || value === false) return null;
      const bytes = await (value as BinaryValue).content();
      const out = imageRelatedProcess(rec.env, rec.def, field, bytes);
      if (out === null || !out.length) return null;
      return out === bytes ? value : binaryBytes(out);
    }
    return value;
  }
  if (field.type === "properties" && field.definitionRecord && field.definitionRecordField) {
    // fields_properties.py Properties._compute: the definition's default values; an empty definition keeps the value
    const container = await rec.rel(field.definitionRecord);
    const definition = container ? await container.get(field.definitionRecordField) : null;
    if (Array.isArray(definition) && definition.length) throw new NotPorted(`properties defaults of ${rec.def.name}.${field.name} from a non-empty definition`);
    return rec.prev(field.name);
  }
  if (field.name === "display_name" && !hooksOf(rec.def.name).displayName) {
    refuseOverriddenDisplayName(rec.def.name, rec.env.cr);
    return baseRecordDisplayName(rec);
  }
  throw new NotPorted(`compute of ${rec.def.name}.${field.name} on ${rec.id === null ? "a new record" : "a record"}`);
}

/** models.py:1503-1517 BaseModel._compute_display_name on a record (the `super()` of the overrides on new records). */
export async function baseRecordDisplayName(rec: Rec): Promise<unknown> {
  {
    // models.py:1504 _compute_display_name: the _rec_name's convert_to_display_name (fields.py:1220)
    const recName = rec.def.recName;
    if (!recName) return rec.id === null ? `${rec.def.name},${rec.origin ?? "NewId"}` : `${rec.def.name},${rec.id}`;
    const rf = rec.def.fields.get(recName)!;
    if (rf.type === "many2one") {
      const co = await rec.rel(recName);
      return co ? co.get("display_name") : false;
    }
    if (!["char", "text", "selection", "integer", "float"].includes(rf.type)) throw new NotPorted(`display_name over a ${rf.type} _rec_name (${rec.def.name})`);
    const v = await rec.get(recName);
    return v === null || v === false || v === "" || v === 0 ? false : String(v);
  }
}

export class DbRec implements Rec {
  private readonly cache = new Map<string, unknown>();
  /**
   * The stored fields of the record read so far (the hand port's computes here, a compiled compute's run through
   * compiler/runtime/install.ts). RecomputeQueue: an init column's compute that reads its own field first fetches it,
   * with its NULL, into Odoo's cache (models.py `_fetch_field`, fields.py `_insert_cache`), and compares its value with
   * that None (l10n_tr's journals: `if journal.l10n_tr_default_sales_return_account_id: continue`). Reading other fields
   * does not: a field to compute is left out of the prefetch (partner_title's title_id, 13 of 351 dirty).
   */
  readonly readStored = new Set<string>();
  constructor(readonly env: Environment, readonly def: ModelDef, readonly id: number) {}
  get origin(): number { return this.id; }

  async get(name: string): Promise<unknown> {
    if (name === "id") return this.id;
    if (this.cache.has(name)) return this.cache.get(name);
    const field = fieldOf(this.def, name);
    let value: unknown;
    if (!field.store && field.compute && recordCompute(this.def.name, name) && !hasReadCompute(this.def.name, name)) {
      value = await computeValue(this, field);
    } else {
      // fields.py Field.__get__: a stored field marked to compute (`env.records_to_compute`) is computed on access
      if (field.store && isComputed(field)) await computePending(this.env, this.def.name, name, this.id);
      if (field.store && field.column) this.readStored.add(name);
      const values = await new ModelImpl(this.env, this.def).values([this.id], field);
      // fields.py `_fetch_field` -> models.py `_fetch_query`: a record that does not exist raises MissingError (a value
      // read through a many2one to a missing id, e.g. a create given `partner_id: 999999`); values without its id are
      // checked against the table once
      if (!values.has(this.id) && field.store && !(await this.exists())) {
        throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${this.def.name}(${this.id},), User: ${this.env.uid})`);
      }
      value = values.get(this.id) ?? null;
      if (value === null) value = emptyValue(field);
    }
    this.cache.set(name, value);
    return value;
  }

  private async exists(): Promise<boolean> {
    if (this.def.abstract || !this.def.table) return true;
    return (await this.env.cr.query(`SELECT 1 FROM "${this.def.table}" WHERE id = $1`, [this.id])).rows.length > 0;
  }

  async rel(name: string): Promise<Rec | null> {
    const value = await this.get(name);
    if (typeof value !== "number") return null;
    return new DbRec(this.env, this.env.reg.model(fieldOf(this.def, name).relation!), value);
  }

  async rels(name: string): Promise<Rec[]> {
    const value = await this.get(name);
    const co = this.env.reg.model(fieldOf(this.def, name).relation!);
    return (Array.isArray(value) ? value : []).map((id) => new DbRec(this.env, co, Number(id)));
  }

  async prev(name: string): Promise<unknown> {
    const field = fieldOf(this.def, name);
    if (!field.store) return emptyValue(field);
    if (field.column) this.readStored.add(name);
    return (await new ModelImpl(this.env, this.def).values([this.id], field)).get(this.id) ?? emptyValue(field);
  }
}

/**
 * `DbRec.get` for many records at once, with the same branches (record computes one by one, pending stored computes
 * first, then one `values()` call): the prefetch of compiled code (compiler/runtime/records.ts), as Odoo's
 * Field.__get__ fetches or computes the field for the record's prefetch set.
 */
export async function readFieldBatch(env: Environment, def: ModelDef, ids: readonly number[], name: string): Promise<Map<number, unknown>> {
  const field = fieldOf(def, name);
  const out = new Map<number, unknown>();
  if (!field.store && field.compute && recordCompute(def.name, name) && !hasReadCompute(def.name, name)) {
    for (const id of ids) out.set(id, await new DbRec(env, def, id).get(name));
    return out;
  }
  if (field.store && isComputed(field)) for (const id of ids) await computePending(env, def.name, name, id);
  const values = await new ModelImpl(env, def).values(ids, field);
  for (const id of ids) {
    const v = values.get(id) ?? null;
    out.set(id, v === null ? emptyValue(field) : v);
  }
  return out;
}

/** Whether a read-side compute hook exists (hooks.ts `computed`, verified by the read scenarios). */
function hasReadCompute(model: string, field: string): boolean {
  if (field === "display_name" && hooksOf(model).displayName) return true;
  return hooksOf(model).computed?.[field] !== undefined;
}

// ------------------------------------------------------------------------------------------------------------
// Values assigned to non-stored fields by write() stay in the transaction cache (fields.py write -> _update_cache)
// until a dependency is modified; reads of the same request see them.
// ------------------------------------------------------------------------------------------------------------

function overlayKey(model: string, field: string): string { return `wr.overlay:${model}.${field}`; }

export function setOverlay(env: Environment, model: string, field: string, ids: readonly number[], value: unknown): void {
  const key = overlayKey(model, field);
  const m = (env.cache.get(key) as Map<number, unknown> | undefined) ?? new Map<number, unknown>();
  for (const id of ids) m.set(id, value);
  env.cache.set(key, m);
}

export function overlayOf(env: Environment, model: string, field: string): Map<number, unknown> | undefined {
  return env.cache.get(overlayKey(model, field)) as Map<number, unknown> | undefined;
}

/** `modified(fnames)` for the overlay: drop the cached values of the dependents of `fields` (transitively). */
export function invalidateOverlay(env: Environment, def: ModelDef, ids: readonly number[], fields: Iterable<string>): void {
  const todo = [...fields];
  const seen = new Set<string>();
  while (todo.length) {
    const f = todo.pop()!;
    for (const dep of localDependents(def, f)) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      const m = overlayOf(env, def.name, dep);
      if (m) for (const id of ids) m.delete(id);
      todo.push(dep);
    }
  }
}

/**
 * Models whose new records read their inherited fields from a new parent record (fields.py:1951-1970) and assign them
 * on it (web models.py:2321-2326, :2355-2363), so that the parent's computes run as in Odoo. Measured on
 * product.product (round 5: a variant's `is_storable` False gave Odoo `store_by: "untracked"`); the other `_inherits`
 * models (res.users, ...) still read the inherited fields on the record itself.
 */
export const DELEGATE_PARENT_MODELS: ReadonlySet<string> = new Set(["product.product"]);

/**
 * A new record (`model.new(values, origin=...)`): assigned values are kept; computed fields are computed on first
 * access and invalidated when a dependency is assigned (`modified`), except protected fields.
 */
export class NewRec implements Rec {
  readonly values = new Map<string, unknown>();
  /**
   * The new parent record of each `_inherits` link (fields.py:1951-1970: the parent of a new record is a new record
   * with the inherited values of its cache; with an origin, models.py convert_to_cache of a delegate field gives
   * `NewId(origin)`), for the models of DELEGATE_PARENT_MODELS. The inherited fields are related fields through it, so
   * the parent's computes run on it.
   */
  private parents: Map<string, NewRec> | null = null;
  /** The new records whose delegate parent this record is, with their link (the trigger `<link>.<field>` of their
   *  inherited fields: a parent field invalidated invalidates the children's inherited field). */
  delegateChildren: { readonly rec: NewRec; readonly via: string }[] = [];
  /** The defaults of a new delegate parent without origin (fields.py:1974-1986 `default_get` on the parent). */
  parentDefaultOf: ((parent: NewRec, name: string) => Promise<unknown>) | null = null;
  /** Fields whose value was computed (and may be invalidated). */
  private readonly computedNames = new Set<string>();
  readonly protectedFields = new Set<string>();
  readonly originRec: DbRec | null;
  constructor(readonly env: Environment, readonly def: ModelDef, readonly origin: number | null) {
    this.originRec = origin === null ? null : new DbRec(env, def, origin);
  }
  get id(): null { return null; }
  /** `NewId.ref`: the client's virtual id of a new x2many line. */
  ref: unknown = null;

  async get(name: string): Promise<unknown> {
    if (name === "id") return null;
    if (this.values.has(name)) return this.values.get(name);
    const field = fieldOf(this.def, name);
    let value: unknown;
    if (isComputed(field) && (!this.originRec || this.invalidated.has(name))) {
      // fields.py compute_value protects the fields being computed: a read during their compute gets the cache
      // (an unguarded async cycle never overflows the stack, it hangs the worker)
      if (this.computing.includes(name)) return this.prev(name);
      this.computing.push(name);
      try {
        // `env.remove_to_compute(other, self)` at the top of the compute (calendar_event.py:544-545): the other field
        // is no longer marked, its read gets the cache (the stored field kept its value when marked, models.py:6341)
        for (const other of REMOVE_TO_COMPUTE.get(`${this.def.name}.${name}`) ?? []) this.removeToCompute(other);
        value = await computeValue(this, field);
      } finally {
        this.computing.pop();
      }
      this.computedNames.add(name);
    } else if (this.originRec) {
      value = await this.originRec.get(name);
    } else if (name === "create_date" || name === "write_date") {
      value = null;
    } else {
      const fallback = this.defaultOf ? await this.defaultOf(name) : undefined;
      value = fallback !== undefined ? fallback : emptyValue(field);
    }
    this.values.set(name, value);
    return value;
  }

  /** fields.py:1858-1870 the default of a field nobody assigned; set on the unsaved parent of an onchange line. */
  defaultOf: ((name: string) => Promise<unknown>) | null = null;

  /** Fields whose compute is running (innermost last). */
  private readonly computing: string[] = [];
  /** Fields marked to recompute: an origin's database value no longer applies. */
  private readonly invalidated = new Set<string>();
  private readonly previous = new Map<string, unknown>();

  async prev(name: string): Promise<unknown> {
    if (this.previous.has(name)) return this.previous.get(name);
    if (this.originRec) return this.originRec.prev(name);
    return emptyValue(fieldOf(this.def, name));
  }

  /**
   * Whether Odoo's cache holds a value for `name` on this record: a value, one a modification marked to recompute
   * (Odoo marks a stored compute of a new record without dropping its cache), or the origin's. After
   * `env.remove_to_compute(field, record)` a read returns that value (`prev`); without one Odoo computes it.
   */
  hasCacheValue(name: string): boolean {
    return this.values.has(name) || this.previous.has(name) || this.originRec !== null;
  }

  /**
   * A copy of this new record's state (cache, invalidations, previous values, protections): the compiler's shadow mode
   * runs compiled code on the copy so that the record the hand port computes keeps its own state
   * (compiler/PLAN.md "Vilka nycklar som får skuggas"). Related new records are shared, not copied.
   */
  shadowCopy(): NewRec {
    const c = new NewRec(this.env, this.def, this.origin);
    for (const [k, v] of this.values) c.values.set(k, v);
    for (const n of this.computedNames) c.computedNames.add(n);
    for (const n of this.protectedFields) c.protectedFields.add(n);
    for (const n of this.invalidated) c.invalidated.add(n);
    for (const [k, v] of this.previous) c.previous.set(k, v);
    c.ref = this.ref;
    c.defaultOf = this.defaultOf;
    c.cascaded = this.cascaded;
    c.parents = this.parents;
    c.delegateChildren = this.delegateChildren;
    c.parentDefaultOf = this.parentDefaultOf;
    return c;
  }

  /** The `_inherits` link of an inherited field of this record, when its model delegates to a new parent. */
  delegateLink(name: string): string | null {
    if (!DELEGATE_PARENT_MODELS.has(this.def.name)) return null;
    const f = this.def.fields.get(name);
    return f?.inheritedFrom && f.inheritedVia && !f.store ? f.inheritedVia : null;
  }

  /** Whether `name` is an `_inherits` link field of this record whose parent is a new record. */
  private isDelegateField(name: string): boolean {
    return DELEGATE_PARENT_MODELS.has(this.def.name) && [...this.def.inherits.values()].includes(name);
  }

  /** fields.py:1951-1970: the new parent record behind the link `via`, created on first access. */
  async delegateParent(via: string): Promise<NewRec> {
    const known = this.parents?.get(via);
    if (known) return known;
    const parentModel = [...this.def.inherits].find(([, link]) => link === via)?.[0];
    if (!parentModel) throw new NotPorted(`${this.def.name}.${via} is not an _inherits link`);
    const parentDef = this.env.reg.model(parentModel);
    const current = this.values.has(via) ? this.values.get(via) : this.originRec ? await this.originRec.get(via) : null;
    let parent: NewRec;
    if (current instanceof NewRec) parent = current;
    else if (typeof current === "number") parent = new NewRec(this.env, parentDef, current);
    else {
      parent = new NewRec(this.env, parentDef, null);
      // "a new record, with the same values as record for the corresponding inherited fields"
      for (const [name, value] of this.values) if (this.delegateLink(name) === via) parent.values.set(name, value);
      const defaults = this.parentDefaultOf;
      if (defaults) parent.defaultOf = (name) => defaults(parent, name);
      // fields.py:1963-1968 and fields_relational.py `_update_inverse`: the one2manys of the link on the new parent
      // (product.template.product_variant_ids) hold this record
      for (const f of parentDef.fields.values()) {
        if (f.type === "one2many" && f.relation === this.def.name && f.relationField === via && !isComputed(f)) parent.values.set(f.name, [this]);
      }
    }
    parent.delegateChildren.push({ rec: this, via });
    (this.parents ??= new Map()).set(via, parent);
    return parent;
  }

  /** Put a value in cache without triggering anything (`_update_cache`). */
  put(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  /** `record[name] = value` on a new record: update the cache and mark the dependents (`modified`). */
  async set(name: string, value: unknown): Promise<void> {
    // fields.py __set__ of a new record: `convert_to_cache` first; a Float with digits is rounded to them
    // (fields_numeric.py:169-173 "apply rounding here, otherwise value in cache may be wrong!"): a quantity 0.333 of a
    // 'Product Unit' field is 0.33 before any compute reads it (round 10 fix 1)
    const field = this.def.fields.get(name);
    if (field?.type === "float" && field.digits && typeof value === "number") value = floatRound(value, field.digits[1]);
    this.values.set(name, value);
    await this.modified([name]);
    const via = this.delegateLink(name);
    if (via) await this.assignOnParent(via, name, value);
  }

  /**
   * fields.py:2019-2022 (`__set__` of an inherited field on new records): the value is assigned on the new parent too,
   * whose `modified` marks the parent's computes and, through them, this record's inherited fields.
   */
  async assignOnParent(via: string, name: string, value: unknown): Promise<void> {
    await (await this.delegateParent(via)).set(name, value);
  }

  /**
   * A copy of a stored line made because a field of its parent changed (the parent's cache holds new lines with
   * origin, models.py:6375-6440 `_modified_triggers` through the inverse); not an edit of the form.
   */
  cascaded = false;

  /** `invalidate_recordset([name])` + `env.add_to_compute(field, record)`: recomputed on the next read; its dependents
   * are not marked (account_move.py:8139-8147 `_conditional_add_to_compute`). */
  addToCompute(name: string): void {
    this.invalidate(name);
  }

  /** `env.remove_to_compute(field, record)`: a field marked to recompute takes back the value it had in cache (an
   * origin's value when nothing else was cached); a new record without origin and without a cached value computes it
   * on read (fields.py __get__ on a cache miss). */
  private removeToCompute(name: string): void {
    if (!this.invalidated.has(name) || this.values.has(name) || this.computing.includes(name)) return;
    if (this.previous.has(name)) this.values.set(name, this.previous.get(name));
    else if (!this.originRec) return;
    this.invalidated.delete(name);
  }

  private invalidate(name: string): void {
    if (this.values.has(name)) this.previous.set(name, this.values.get(name));
    this.values.delete(name);
    this.computedNames.delete(name);
    this.invalidated.add(name);
  }

  /**
   * models.py:6269 modified() on new records: invalidate the computed fields depending on `names`, transitively, on
   * this record, on the lines of its one2many fields (a line field depending on `<inverse>.<name>`, e.g.
   * sale.order.line.company_id related to order_id.company_id) and on the new parent of a line (a parent field
   * depending on `<one2many>.<name>`, e.g. sale.order.margin on order_line.margin). Protected fields
   * (`env.protecting`) are neither invalidated nor followed.
   */
  async modified(names: readonly string[]): Promise<void> {
    const todo: [NewRec, string][] = names.map((n) => [this, n]);
    const seen = new Map<NewRec, Set<string>>();
    const mark = (rec: NewRec, dep: string): void => {
      const s = seen.get(rec) ?? new Set<string>();
      seen.set(rec, s);
      if (s.has(dep) || rec.protectedFields.has(dep)) return;
      s.add(dep);
      rec.invalidate(dep);
      todo.push([rec, dep]);
    };
    // the inherited field `<link>.<name>` of a delegate child depends on the parent's field
    const relay = (rec: NewRec, name: string): void => {
      for (const child of rec.delegateChildren) if (child.rec.delegateLink(name) === child.via) mark(child.rec, name);
    };
    while (todo.length) {
      const [rec, name] = todo.pop()!;
      for (const dep of localDependents(rec.def, name)) mark(rec, dep);
      relay(rec, name);
      for (const [x2, deps] of lineDependents(rec.env, rec.def, name)) {
        for (const line of await rec.lineCopies(x2)) for (const dep of deps) mark(line, dep);
      }
      for (const [m2o, x2s] of parentInverses(rec.env, rec.def)) {
        const cached = rec.values.get(m2o);
        // the new parent of a delegate link is the link's value (fields.py:1951-1970)
        const parent = cached instanceof NewRec ? cached : rec.parents?.get(m2o);
        if (!(parent instanceof NewRec)) continue;
        for (const x2 of x2s) for (const dep of parentDependents(parent.def, x2, name)) mark(parent, dep);
      }
    }
  }

  /**
   * The lines of a one2many as new records whose inverse is this record (fields_relational.py:1120-1126: the inverse
   * of every line of a new record is put in cache), copying the stored lines (`cascaded`).
   */
  async lineCopies(x2: string): Promise<NewRec[]> {
    const field = fieldOf(this.def, x2);
    const co = this.env.reg.model(field.relation!);
    const inv = field.relationField!;
    const current = await this.get(x2);
    if (!Array.isArray(current)) return [];
    const lines = current.map((l: unknown) => {
      if (l instanceof NewRec) {
        if (!l.values.has(inv)) l.put(inv, this);
        return l;
      }
      if (typeof l !== "number") throw new NotPorted(`x2many line ${String(l)} in ${this.def.name}.${x2}`);
      const copy = new NewRec(this.env, co, l);
      copy.cascaded = true;
      copy.put(inv, this);
      return copy;
    });
    this.values.set(x2, lines);
    // the same lines in the one2manys with a domain over the same inverse (account.move.invoice_line_ids beside
    // line_ids) are the same records in Odoo's cache: they get the same copies
    const byOrigin = new Map(lines.filter((l) => l.origin !== null).map((l) => [l.origin!, l]));
    for (const other of this.def.fields.values()) {
      if (other.name === x2 || other.type !== "one2many" || other.relation !== field.relation || other.relationField !== inv || isComputed(other)) continue;
      const value = await this.get(other.name);
      if (!Array.isArray(value)) continue;
      this.values.set(other.name, value.map((l: unknown) => {
        if (typeof l !== "number") return l;
        const copy = byOrigin.get(l);
        if (!copy) throw new NotPorted(`${this.def.name}.${other.name} line ${l} outside ${x2}`);
        return copy;
      }));
    }
    return lines;
  }

  async rel(name: string): Promise<Rec | null> {
    if (this.isDelegateField(name)) return this.delegateParent(name);
    const value = await this.get(name);
    if (value instanceof NewRec) return value;
    if (typeof value !== "number") return null;
    return new DbRec(this.env, this.env.reg.model(fieldOf(this.def, name).relation!), value);
  }

  async rels(name: string): Promise<Rec[]> {
    const value = await this.get(name);
    const co = this.env.reg.model(fieldOf(this.def, name).relation!);
    if (!Array.isArray(value)) return [];
    return value.map((id) => {
      if (id instanceof NewRec) return id; // a new line (Command.CREATE in onchange values)
      if (typeof id !== "number") throw new NotPorted(`x2many line ${String(id)} in ${this.def.name}.${name}`);
      return new DbRec(this.env, co, id);
    });
  }
}

const LINE_DEPENDENTS = new WeakMap<ModelDef, Map<string, [string, string[]][]>>();

/** depends paths of a computed field (`@api.depends` and `related`), split in segments. */
function dependsPaths(f: FieldDef): string[][] {
  const paths = [...f.depends];
  if (f.related && !paths.includes(f.related)) paths.push(f.related);
  return paths.map((p) => p.split("."));
}

/** Stored one2many fields of `def` with their inverse many2one (models.py `field_inverses`, without domain). */
function one2manys(env: Environment, def: ModelDef): FieldDef[] {
  return [...def.fields.values()].filter((f) => f.type === "one2many" && f.relation && f.relationField && !isComputed(f)
    && env.reg.models.has(f.relation) && !hasDomain(f));
}

function hasDomain(f: FieldDef): boolean {
  return Array.isArray(f.domain) ? f.domain.length > 0 : Boolean(f.domain) && f.domain !== "[]";
}

/** For a field of `def`, the one2many fields whose lines have computed fields depending on `<inverse>.<field>`. */
function lineDependents(env: Environment, def: ModelDef, name: string): [string, string[]][] {
  let index = LINE_DEPENDENTS.get(def);
  if (!index) {
    index = new Map();
    for (const x2 of one2manys(env, def)) {
      const co = env.reg.model(x2.relation!);
      const byField = new Map<string, string[]>();
      for (const f of co.fields.values()) {
        if (!isComputed(f)) continue;
        for (const segs of dependsPaths(f)) {
          if (segs[0] !== x2.relationField || segs.length < 2) continue;
          const list = byField.get(segs[1]!) ?? [];
          if (!list.includes(f.name)) list.push(f.name);
          byField.set(segs[1]!, list);
        }
      }
      for (const [field, deps] of byField) index.set(field, [...(index.get(field) ?? []), [x2.name, deps]]);
    }
    LINE_DEPENDENTS.set(def, index);
  }
  return index.get(name) ?? [];
}

const PARENT_INVERSES = new WeakMap<ModelDef, [string, string[]][]>();

/** The many2one fields of a line model that are the inverse of a one2many of their comodel, with those one2manys. */
function parentInverses(env: Environment, def: ModelDef): [string, string[]][] {
  let list = PARENT_INVERSES.get(def);
  if (!list) {
    const m = new Map<string, string[]>();
    for (const f of def.fields.values()) {
      if (f.type !== "many2one" || !f.relation || !env.reg.models.has(f.relation)) continue;
      const x2s = one2manys(env, env.reg.model(f.relation)).filter((x) => x.relation === def.name && x.relationField === f.name).map((x) => x.name);
      if (x2s.length) m.set(f.name, x2s);
    }
    list = [...m];
    PARENT_INVERSES.set(def, list);
  }
  return list;
}

const PARENT_DEPENDENTS = new WeakMap<ModelDef, Map<string, string[]>>();

/** Computed fields of `def` depending on `<x2>.<name>`. */
function parentDependents(def: ModelDef, x2: string, name: string): string[] {
  let index = PARENT_DEPENDENTS.get(def);
  if (!index) {
    index = new Map();
    for (const f of def.fields.values()) {
      if (!isComputed(f)) continue;
      for (const segs of dependsPaths(f)) {
        if (segs.length < 2) continue;
        const key = `${segs[0]}.${segs[1]}`;
        const l = index.get(key) ?? [];
        if (!l.includes(f.name)) l.push(f.name);
        index.set(key, l);
      }
    }
    PARENT_DEPENDENTS.set(def, index);
  }
  return index.get(`${x2}.${name}`) ?? [];
}

const LOCAL_DEPENDENTS = new WeakMap<ModelDef, Map<string, string[]>>();

/**
 * Computed fields of `def` whose `@api.depends` path starts with `name` (the record's own field), or reaches it
 * through a many2one onto the same record kind: for a new record only its own fields change.
 */
export function localDependents(def: ModelDef, name: string): string[] {
  let index = LOCAL_DEPENDENTS.get(def);
  if (!index) {
    index = new Map<string, string[]>();
    for (const f of def.fields.values()) {
      if (!isComputed(f)) continue;
      const deps = new Set(f.depends.map((p) => p.split(".")[0]!));
      if (f.related) deps.add(f.related.split(".")[0]!);
      for (const d of deps) index.set(d, [...(index.get(d) ?? []), f.name]);
    }
    LOCAL_DEPENDENTS.set(def, index);
  }
  return index.get(name) ?? [];
}

// ------------------------------------------------------------------------------------------------------------
// Stored computed fields: the recompute queue after create/write
// ------------------------------------------------------------------------------------------------------------

interface Trigger { readonly model: string; readonly field: string; readonly prefix: readonly string[] }

const TRIGGERS = new WeakMap<object, Map<string, Trigger[]>>();

/**
 * For a model and a field, the stored computed fields (any model) whose depends paths go through it. Every stored
 * computed many2many is among them (its relation rows are rewritten as `Command.set`, fields.py `_update_cache` of a
 * compute): until round 9 only purchase.order's picking_ids and invoice_ids were, so a record created without an
 * onchange (account.move.send.wizard over RPC) kept an empty relation where Odoo computes one. A stored computed
 * many2many without a ported compute refuses (`computeValue`) instead of staying empty.
 */
function triggersOf(env: Environment, model: string, field: string): Trigger[] {
  let index = TRIGGERS.get(env.reg);
  if (!index) {
    index = new Map<string, Trigger[]>();
    // the dependencies of every computed field, keyed by the field they go through (registry.py:730-750
    // `_field_triggers` from fields.py:927-989 `resolve_depends`)
    const direct = new Map<string, Trigger[]>();
    const nonStored = new Set<string>();
    for (const def of env.reg.models.values()) {
      for (const f of def.fields.values()) {
        if (f.inheritedFrom && f.inheritedVia && !f.store) {
          // an `_inherits` field is a non-stored related field `<link>.<name>` (fields.py `_setup_related_full` via
          // models.py `_add_inherited_fields`): it relays the parent's field to the fields depending on it (res.users.tz
          // -> partner_id.tz, so mail.activity.user_tz follows a partner's time zone). A stored field of the model's own
          // related through the link (product.product.is_favorite) is an ordinary related compute.
          nonStored.add(`${def.name}.${f.name}`);
          const segs = [f.inheritedVia, f.name];
          direct.set(`${def.name}.${segs[0]}`, [...(direct.get(`${def.name}.${segs[0]}`) ?? []), { model: def.name, field: f.name, prefix: [] }]);
          direct.set(`${f.inheritedFrom}.${segs[1]}`, [...(direct.get(`${f.inheritedFrom}.${segs[1]}`) ?? []), { model: def.name, field: f.name, prefix: [segs[0]!] }]);
          continue;
        }
        if (!isComputed(f) || (f.inheritedFrom && !f.store)) continue;
        const stored = f.store && f.type !== "one2many";
        if (!stored) {
          // a non-stored computed field only relays its dependencies to the stored fields depending on it
          // (registry.py:640-700 `get_trigger_tree` walks the triggers transitively)
          if (f.store) continue;
          nonStored.add(`${def.name}.${f.name}`);
        }
        const paths = [...f.depends];
        if (f.related && !paths.includes(f.related)) paths.push(f.related);
        for (const path of paths) {
          const segs = path.split(".");
          let cur: ModelDef | undefined = def;
          for (let k = 0; k < segs.length && cur; k++) {
            // fields.py:942-945: fields on regular models never trigger recomputations on transient models
            if (def.transient && !cur.transient) break;
            const key = `${cur.name}.${segs[k]}`;
            direct.set(key, [...(direct.get(key) ?? []), { model: def.name, field: f.name, prefix: segs.slice(0, k) }]);
            const sf = cur.fields.get(segs[k]!);
            // fields.py:982-984 `resolve_depends`: a one2many step also depends on its inverse many2one, reached
            // through the one2many itself (a record that moves to another parent marks both parents)
            if (sf?.type === "one2many" && sf.relation && sf.relationField) {
              const ikey = `${sf.relation}.${sf.relationField}`;
              direct.set(ikey, [...(direct.get(ikey) ?? []), { model: def.name, field: f.name, prefix: segs.slice(0, k + 1) }]);
            }
            cur = sf?.relation ? env.reg.models.get(sf.relation) : undefined;
          }
        }
      }
    }
    // expand the non-stored fields: a trigger of N (prefix p) followed by a trigger of S on N (prefix q) is a
    // trigger of S with prefix q + p
    const expand = (key: string, depth: number, seen: Set<string>): Trigger[] => {
      const out: Trigger[] = [];
      for (const t of direct.get(key) ?? []) {
        const tk = `${t.model}.${t.field}`;
        if (!nonStored.has(tk)) { out.push(t); continue; }
        if (depth > 8 || seen.has(tk)) continue;
        for (const u of expand(tk, depth + 1, new Set([...seen, tk]))) out.push({ model: u.model, field: u.field, prefix: [...u.prefix, ...t.prefix] });
      }
      return out;
    };
    for (const key of direct.keys()) {
      const list = expand(key, 0, new Set());
      if (list.length) index.set(key, list);
    }
    TRIGGERS.set(env.reg, index);
  }
  return index.get(`${model}.${field}`) ?? [];
}

/** Toposort rank of stored computed fields by their local (first segment) dependencies. */
function localRank(def: ModelDef, name: string, seen = new Set<string>()): number {
  if (seen.has(name)) return 0;
  seen.add(name);
  const f = def.fields.get(name);
  if (!f || !isComputed(f)) return 0;
  let rank = 0;
  const deps = f.depends.map((p) => p.split(".")[0]!);
  if (f.related) deps.push(f.related.split(".")[0]!);
  for (const d of deps) if (d !== name) rank = Math.max(rank, 1 + localRank(def, d, seen));
  return rank;
}

/** "model.field" -> the fields its compute takes off the to-compute list (`env.remove_to_compute`). */
const REMOVE_TO_COMPUTE = new Map<string, readonly string[]>();
export function registerRemoveToCompute(model: string, field: string, others: readonly string[]): void {
  REMOVE_TO_COMPUTE.set(`${model}.${field}`, others);
}

/**
 * `env.protecting` (odoo/odoo/orm/environments.py `protecting`, models.py:4382 and :3905): the fields protected by a
 * create or write stay protected for every operation nested in it (the x2many records created by the create, the
 * inverse methods), not only for that call's own queue. The protections live on the transaction (the cursor), as
 * Odoo's `env.transaction.protected`.
 */
const PROTECTED = new WeakMap<object, Map<string, Set<number>>[]>();

/** The queues whose marked fields are computed on access (`RecomputeQueue.readable`), per transaction (cursor). */
const READABLE = new WeakMap<object, RecomputeQueue[]>();

/** fields.py Field.__get__ for a stored computed field of a database record: compute it when a queue marked it. */
async function computePending(env: Environment, model: string, field: string, id: number): Promise<void> {
  const stack = READABLE.get(env.cr);
  if (!stack?.length) return;
  for (const q of [...stack].reverse()) await q.computeIfPending(model, field, id);
}

export class RecomputeQueue {
  private readonly pending = new Map<string, Set<number>>();
  /** model.field -> ids that must not be recomputed (protected: given in vals, models.py:4182, :3880). */
  private readonly protectedIds = new Map<string, Set<number>>();
  /** Records created by the create call owning this queue, by model. */
  private readonly fresh = new Map<string, Set<number>>();
  /** model.field -> records whose value of the field is in no cache: a column just added (fields.py:1342-1345
   *  `_init_column_data` marks them to compute), so whatever the compute assigns is written (`_filter_not_equal`). */
  private readonly uncached = new Map<string, Set<number>>();
  /** model.field -> records whose new column is cached with the NULL of its row (fields.py `_insert_cache` keeps the
   *  raw column value, None): a computed False or 0 differs from it (`_filter_not_equal`), so it is written. */
  private readonly nullCached = new Map<string, Set<number>>();
  constructor(private readonly env: Environment) {}

  markNullCached(model: string, field: string, ids: readonly number[]): void {
    const key = `${model}.${field}`;
    const s = this.nullCached.get(key) ?? new Set<number>();
    for (const id of ids) s.add(id);
    this.nullCached.set(key, s);
  }

  markUncached(model: string, field: string, ids: readonly number[]): void {
    const key = `${model}.${field}`;
    const s = this.uncached.get(key) ?? new Set<number>();
    for (const id of ids) s.add(id);
    this.uncached.set(key, s);
  }

  markCreated(model: string, ids: readonly number[]): void {
    const s = this.fresh.get(model) ?? new Set<number>();
    for (const id of ids) s.add(id);
    this.fresh.set(model, s);
  }

  protect(model: string, fields: Iterable<string>, ids: readonly number[]): void {
    for (const f of fields) {
      const key = `${model}.${f}`;
      const s = this.protectedIds.get(key) ?? new Set<number>();
      for (const id of ids) s.add(id);
      this.protectedIds.set(key, s);
    }
  }

  /** `records.modified(fnames)`: enqueue the stored computed fields depending on them. */
  async modified(model: string, ids: readonly number[], fields: Iterable<string>): Promise<void> {
    if (!ids.length) return;
    // The searches of the triggers are reads (as superuser, nothing is written until they all ran), independent of
    // each other: they are sent together, so that they share round trips (src/db.ts pipelining), and their records are
    // marked in the triggers' order afterwards, as one after the other did; the first failure in that order is thrown.
    const found: (readonly [Trigger, Promise<number[]>])[] = [];
    for (const fname of fields) {
      for (const t of triggersOf(this.env, model, fname)) {
        let targets: number[] | Promise<number[]>;
        if (!t.prefix.length) targets = t.model === model ? [...ids] : [];
        else if (this.createdOnly(model, ids) && this.lastPrefixIsMany2one(t)) {
          // models.py:6388-6390 _modified_triggers(create=True): no other record references a new record through a
          // many2one yet, so the backward traversal stops (and never searches a non-stored many2one)
          targets = [];
        } else {
          targets = this.traverse(t, ids);
        }
        found.push([t, Promise.resolve(targets)]);
      }
    }
    const targets = await inOrder(found.map(([, p]) => p));
    found.forEach(([t], i) => this.add(t.model, t.field, targets[i]!));
  }

  /**
   * models.py:6375-6437 _modified_triggers walks the dependency path backwards one field at a time and stops at an
   * empty recordset (so a non-stored step after it is never searched).
   */
  private async traverse(t: Trigger, ids: readonly number[]): Promise<number[]> {
    const env = this.env.sudo().withContext({ ...this.env.context, active_test: false });
    const chain: ModelDef[] = [this.env.reg.model(t.model)];
    for (const seg of t.prefix.slice(0, -1)) chain.push(this.env.reg.model(chain[chain.length - 1]!.fields.get(seg)!.relation!));
    let cur: number[] = [...ids];
    for (let k = t.prefix.length - 1; k >= 0 && cur.length; k--) {
      // :6401-6415: a one2many's inverse many2one is read, `records = self[invf.name]` (fields_relational.py
      // One2many.setup_nonrelated adds it to field_inverses whatever the one2many's domain): the distinct values in
      // the order of `self` (Many2one.convert_to_record_multi), from the transaction's rows, as Odoo from its cache;
      // a record that no longer exists is left out (`self.exists()[invf.name]`, :6417)
      const inverse = many2oneInverse(this.env, chain[k]!, t.prefix[k]!);
      if (inverse !== null) {
        const values = await new ModelImpl(env, inverse.def).values(cur, inverse.field);
        const next = new Set<number>();
        for (const id of cur) {
          const v = values.get(id);
          if (typeof v === "number" && v) next.add(v);
        }
        cur = [...next];
        continue;
      }
      // :6400-6430: through an inverse without domain the records are `self[invf.name]` (the comodel's order);
      // otherwise `model.search([(field.name, 'in', ids)], order='id')`
      const order = hasPlainInverse(this.env, chain[k]!, t.prefix[k]!) ? {} : { order: "id" };
      cur = await new ModelImpl(env, chain[k]!).search(D.cond(t.prefix[k]!, "in", cur), order);
    }
    return cur;
  }

  private createdOnly(model: string, ids: readonly number[]): boolean {
    const fresh = this.fresh.get(model);
    return fresh !== undefined && ids.every((id) => fresh.has(id));
  }

  /** Whether the dependency step that reaches the modified records is a many2one (or many2one_reference). */
  private lastPrefixIsMany2one(t: { model: string; prefix: readonly string[] }): boolean {
    let def: ModelDef | undefined = this.env.reg.models.get(t.model);
    let field: FieldDef | undefined;
    for (const seg of t.prefix) {
      field = def?.fields.get(seg);
      def = field?.relation ? this.env.reg.models.get(field.relation) : undefined;
    }
    return field !== undefined && (field.type === "many2one" || field.type === "many2one_reference");
  }

  /** Run `fn` with this queue's protections in force for the whole transaction (`with env.protecting(...)`). */
  async protecting<T>(fn: () => Promise<T>): Promise<T> {
    const stack = PROTECTED.get(this.env.cr) ?? [];
    PROTECTED.set(this.env.cr, stack);
    stack.push(this.protectedIds);
    try {
      return await fn();
    } finally {
      const i = stack.lastIndexOf(this.protectedIds);
      if (i >= 0) stack.splice(i, 1);
    }
  }

  private isProtected(key: string, id: number): boolean {
    if (this.protectedIds.get(key)?.has(id)) return true;
    for (const m of PROTECTED.get(this.env.cr) ?? []) if (m.get(key)?.has(id)) return true;
    return false;
  }

  add(model: string, field: string, ids: readonly number[]): void {
    const key = `${model}.${field}`;
    const s = this.pending.get(key) ?? new Set<number>();
    for (const id of ids) if (!this.isProtected(key, id)) s.add(id);
    if (s.size) this.pending.set(key, s);
  }

  private readonly propagated = new Set<string>();

  /**
   * Run `fn` with the fields this queue has marked to compute readable as Odoo reads them (fields.py Field.__get__:
   * a record in `env.records_to_compute(field)` is recomputed on access). models.py:4428-4440 `_create` marks the
   * new records' computed fields (`modified(create=True)`) before it creates their x2many lines, so a line whose
   * compute reads its parent's stored compute (res.partner `commercial_partner_id` of a contact created in its
   * company's `child_ids`) sees the computed value, not the empty column.
   */
  async readable<T>(fn: () => Promise<T>): Promise<T> {
    const stack = READABLE.get(this.env.cr) ?? [];
    READABLE.set(this.env.cr, stack);
    stack.push(this);
    try {
      return await fn();
    } finally {
      const i = stack.lastIndexOf(this);
      if (i >= 0) stack.splice(i, 1);
    }
  }

  /** Compute `model.field` of `id` now when it is pending here (taken off the queue first: a read during its own
   * compute gets the column, as fields.py protects the field being computed). */
  async computeIfPending(model: string, field: string, id: number): Promise<void> {
    const key = `${model}.${field}`;
    const s = this.pending.get(key);
    if (!s?.has(id)) return;
    s.delete(id);
    if (!s.size) this.pending.delete(key);
    await this.step(key, [id]);
  }

  /** Flush: compute pending fields in dependency order, write changed values, propagate. */
  async run(): Promise<void> {
    for (let guard = 0; this.pending.size; guard++) {
      if (guard > 500) throw new NotPorted(`recompute did not converge: ${[...this.pending.keys()].join(", ")}`);
      const keys = [...this.pending.keys()];
      // a compute that discards another one runs before it (fields depending on each other have no rank)
      const rank = (k: string): number => (REMOVE_TO_COMPUTE.has(k) ? -1 : rankOf(this.env, k));
      keys.sort((a, b) => rank(a) - rank(b));
      const key = keys[0]!;
      const ids = [...this.pending.get(key)!];
      this.pending.delete(key);
      await this.step(key, ids);
    }
  }

  /** Recompute `key` for `ids`: write the changed values and mark the dependents. */
  private async step(key: string, ids: number[]): Promise<void> {
    {
      const dot = key.lastIndexOf(".");
      const model = key.slice(0, dot), fname = key.slice(dot + 1);
      const def = this.env.reg.model(model);
      const field = fieldOf(def, fname);
      // the rows this transaction has read and not deleted exist (src/sql_cache.ts RowCache.allExist)
      const existing = this.env.cr.rows.allExist(def.table, ids) ? new Set(ids)
        : new Set((await runSql<{ id: number }>(this.env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${ids}::int[])`)).map((r) => r.id));
      const changed: [number, unknown, unknown][] = [];
      for (const id of ids) {
        if (!existing.has(id)) continue;
        const rec = new DbRec(this.env.sudo(), def, id);
        const value = await computeValue(rec, field);
        if (value === NOT_ASSIGNED) continue;
        const old = (await new ModelImpl(this.env.sudo(), def).values([id], field)).get(id) ?? emptyValue(field);
        // a new record has no cache entry to compare with (fields.py Field.write `_filter_not_equal`), so a computed False
        // or 0 reaches the column, which would stay NULL otherwise
        // The same for a column cached with its NULL (None): Boolean, Integer and Float `convert_to_cache` give False
        // or 0, never None (fields_misc.py:30-31, fields_numeric.py), where the other types give None for False. An
        // uncached record whose compute read the field itself (DbRec.readStored) has it cached with its NULL by then
        const readOwn = rec.readStored.has(fname);
        const uncached = Boolean(this.uncached.get(key)?.has(id)) && !readOwn;
        const nullCached = Boolean(this.nullCached.get(key)?.has(id)) || (Boolean(this.uncached.get(key)?.has(id)) && readOwn);
        const firstValue = (this.fresh.get(model)?.has(id) || nullCached) && (value === false || value === 0)
          && ["boolean", "integer", "float", "monetary"].includes(field.type);
        // a datetime with microseconds (preciseDatetime) is compared with the column as Odoo's cache holds it
        const same = value instanceof PreciseDatetime && field.column
          ? (await runSql<{ v: string | null }>(this.env, sql`SELECT ${ident(field.name)}::text AS v FROM ${ident(def.table)} WHERE id = ${id}`))[0]?.v === value.text
          : cacheEqual(normalizeRef(value, id), old);
        // a compute that assigns False to all its records before their values (`self.x = False`): the False differs
        // from a cached value that is not empty, so the record is dirty whatever its final value (fields.py:1685-1692
        // Field.write `_filter_not_equal` then `_update_cache(dirty=True)`), flushed with its write_date
        const reset = RESET_FIRST.has(key) && !cacheEqual(emptyValue(field), old);
        if (firstValue || uncached || !same || reset) changed.push([id, normalizeRef(value, id), old]);
      }
      // registry.field_triggers is transitive (models.py modified -> _modified_triggers): the dependents of a
      // recomputed field are marked when its dependencies were modified, whether or not its value changes
      // (crm.lead team_id -> stage_id -> duration_tracking). They are enqueued for every recomputed record.
      const recomputed = ids.filter((id) => existing.has(id));
      const unqueue = (): void => {
        this.unqueueSelf(key, recomputed);
        for (const other of REMOVE_TO_COMPUTE.get(key) ?? []) this.unqueueSelf(`${model}.${other}`, recomputed);
      };
      if (!changed.length) {
        // fields depending on each other (account.payment journal_id <-> company_id): an unchanged value that already
        // marked its dependents has no cause to mark them again (models.py `modified` marks them once, from the write)
        const first = recomputed.filter((id) => !this.propagated.has(`${key}:${id}`));
        for (const id of first) this.propagated.add(`${key}:${id}`);
        if (first.length) await this.modified(model, first, [fname]);
        unqueue();
        return;
      }
      for (const id of recomputed) this.propagated.add(`${key}:${id}`);
      // mail_thread.py:503 _compute_field_value -> _track_prepare: the write hooks see recomputed values of
      // existing records (records created by this create are discarded by mail.thread's create anyway)
      const hooks = hooksOf(model).write ?? [];
      const fresh = this.fresh.get(model);
      if (field.type === "many2many") {
        // the relation rows of each changed record are replaced by the computed ids (no mail tracking on these fields)
        if (!field.relationTable || !field.column1 || !field.column2) throw new NotPorted(`m2m table ${def.name}.${field.name}`);
        const rel = ident(field.relationTable), c1 = ident(field.column1), c2 = ident(field.column2);
        for (const [id, v] of changed) {
          const list = Array.isArray(v) ? v.map((x) => (x instanceof DbRec ? x.id : Number(x))) : [];
          await runSql(this.env, sql`DELETE FROM ${rel} WHERE ${c1} = ${id}`);
          for (const y of [...new Set(list)]) await runSql(this.env, sql`INSERT INTO ${rel} (${c1}, ${c2}) VALUES (${id}, ${y}) ON CONFLICT DO NOTHING`);
        }
        for (const id of recomputed) this.propagated.add(`${key}:${id}`);
        await this.modified(model, recomputed, [fname]);
        unqueue();
        return;
      }
      if (!field.column && field.store && field.attachment && (field.type === "binary" || field.type === "image")) {
        // a stored related binary in attachments (fields_binary.py Binary.write on the protected records): its
        // attachment, per record in order; another computed attachment field refuses
        if (!field.related) throw new NotPorted(`recompute of the attachment field ${def.name}.${fname}`);
        for (const [id, v] of changed) await writeRecomputedAttachment(this.env, def, field, id, v);
        await this.modified(model, recomputed, [fname]);
        unqueue();
        return;
      }
      // Odoo logs the tracking of recomputed records at precommit, after the records whose write prepared its tracking
      // first (mail_track_mixin.py:91 `precommit.add(self._track_finalize)`): inside another model's open write the
      // recomputed records' tracking is logged when that write's tracking has been logged
      const deferTo = hooks.length > 0 ? await deferredTrackingScope(this.env, model) : null;
      // without write hooks, all records in one call (models.py:4014-4027 groups `_write_multi` by updated fields): the
      // values were all computed above and nothing runs between their writes
      const batched = changed.length > 1 && changed.every(([id]) => !(hooks.length > 0 && !fresh?.has(id)));
      if (batched) await writeColumns(this.env, def, changed.map(([id, v]) => [id, { [fname]: v }]), true, true);
      for (const [id, v, old] of batched ? [] : changed) {
        const hooked = hooks.length > 0 && !fresh?.has(id);
        if (hooked) for (const h of hooks) if (h.beforeWrite) await h.beforeWrite(this.env, [id], { [fname]: v });
        await writeColumns(this.env, def, [[id, { [fname]: v }]], true, true);
        if (hooked) for (const h of hooks) if (h.afterWrite) await h.afterWrite(this.env, [id], { [fname]: v }, new Map([[id, { [fname]: old }]]));
      }
      if (deferTo) await deferTo();
      await this.modified(model, recomputed, [fname]);
      unqueue();
    }
  }

  /**
   * A field that depends on itself through a relation (sale_project `sale_line_id` on `sale_line_id.order_partner_id`)
   * is protected while it is computed (models.py `_recompute_field`: `env.protecting(field_computed[field], records)`):
   * its own modification does not enqueue it again for the same records.
   */
  private unqueueSelf(key: string, ids: readonly number[]): void {
    const s = this.pending.get(key);
    if (!s) return;
    for (const id of ids) s.delete(id);
    if (!s.size) this.pending.delete(key);
  }
}

function rankOf(env: Environment, key: string): number {
  const dot = key.lastIndexOf(".");
  return localRank(env.reg.model(key.slice(0, dot)), key.slice(dot + 1));
}

/** A compute assigning the record itself (`partner.commercial_partner_id = partner`). */
function normalizeRef(value: unknown, id: number): unknown {
  if (value instanceof DbRec) return value.id;
  if (value instanceof NewRec) return id;
  return value;
}

/**
 * `_write_multi` (models.py:3997-4079) for column values already in cache format: one UPDATE per record with
 * write_uid/write_date from the database clock when the model logs access. Translated fields merge the env lang
 * into the stored jsonb (models.py:4031-4043).
 */
/**
 * sql_db.py:295-306 and environments.py:741-750: at commit, the cursor flushes the transaction with its default
 * environment (the first one with a user: the session check's superuser) before and after each precommit hook. A
 * stored computed field recomputed inside a precommit hook (account's `try_loading`) is still pending then, so its
 * `_write_multi` takes that environment's uid (models.py:4008-4010), unless the record carries a pending explicit
 * write, whose `write()` put its own write_uid in the values (models.py:3862-3863). `deferredFlush` opens such a
 * window on the cursor: recomputed columns of records not written explicitly in it get `uid`.
 */
interface DeferredState {
  uid: number;
  /** Records whose explicit write made write_uid dirty (another value than the cached one). */
  written: Set<string>;
  /** Records a create in the window made with stored computes left to run after the INSERT: those fields, by record. */
  created: Map<string, Map<number, readonly string[]>>;
  /**
   * Explicit writes that left write_uid clean (`Field.write` drops a value equal to the cache, fields.py
   * `_filter_not_equal`; a record created in the transaction has its write_uid cached, models.py:4395-4416): the
   * written fields of each record not flushed yet. A query reading one of them flushes it in its environment
   * (src/orm/flush_points.ts); those left at the end are flushed by the precommit's environment, whose uid
   * `_write_multi` takes (models.py:4008-4010).
   */
  pending: Map<string, Map<number, Set<string>>>;
  /** Records with recomputed columns flushed in the window: their write_uid is the flushing uid at the end. */
  recomputed: Map<string, Set<number>>;
  /** The `write()` calls in progress in the window, innermost last (see `invalidateAll`). */
  frames: WriteFrame[];
  /**
   * The fields Odoo leaves dirty on the records a create in the window made, by model: stored computes that run after
   * the INSERT, and the stored fields an inverse writes (account.account's code -> code_store). A query reading one
   * flushes the model (see `flushed`).
   */
  createdDirty: Map<string, Set<string>>;
  /** Records a query flushed in the window, with the query's uid: written to the database by `settle`. */
  flushedAt: Map<string, Map<number, number>>;
}
interface WriteFrame { model: string; ids: ReadonlySet<number>; cleared: boolean }
const DEFERRED = new WeakMap<object, DeferredState>();
export async function deferredFlush<T>(env: Environment, uid: number, fn: () => Promise<T>): Promise<T> {
  const prev = DEFERRED.get(env.cr);
  const state: DeferredState = { uid, written: new Set<string>(), created: new Map(), pending: new Map(), recomputed: new Map(), frames: [], createdDirty: new Map(), flushedAt: new Map() };
  DEFERRED.set(env.cr, state);
  onFieldFlush(env.cr, {
    flushed: (model, field, flushUid) => {
      // models.py:5841-5857 `flush_model(fnames)`: when one of the fields is dirty, `_flush()` (:5859-5905) writes every
      // dirty field of every record of the model, not only those read, with the querying environment's uid
      // (models.py:4008-4011), and they are clean after it. vagb_chart_kr: account 115310's forward reference
      // (account_stock_variation_id) flushed with its parent_id by the parent_store write (:3952-3953); vagb_chart_at:
      // the stock account written by the chart, flushed by the next account's `_get_closest_parent_account` search
      // (account_account.py:653-667), the accounts created since having code_store dirty
      const byId = state.pending.get(model);
      const dirty = Boolean(byId && [...byId.values()].some((fields) => fields.has(field))) || Boolean(state.createdDirty.get(model)?.has(field));
      if (!dirty) return;
      state.createdDirty.delete(model);
      const at = state.flushedAt.get(model) ?? new Map<number, number>();
      state.flushedAt.set(model, at);
      for (const id of byId?.keys() ?? []) at.set(id, flushUid);
      state.pending.delete(model);
      // the records whose stored computes have not run (the port's `created` and `recomputed`) are only marked to
      // compute in Odoo, not dirty: `_recompute_model(fnames)` runs the read fields only, so they are not flushed
    },
    cached: (model, field, ids) => {
      const byId = state.pending.get(model);
      return Boolean(byId && ids.length && ids.every((id) => byId.get(id)?.has(field)));
    },
  });
  let out: T;
  try {
    out = await fn();
  } finally {
    onFieldFlush(env.cr, null);
    if (prev) DEFERRED.set(env.cr, prev); else DEFERRED.delete(env.cr);
  }
  // the explicit writes left pending and the recomputed columns are flushed by the precommit's environment
  await flushState(env, state, uid);
  return out;
}

/**
 * A column write done in raw SQL (with write_uid = env.uid) inside a `deferredFlush` window, told to the window as
 * `writeColumns` would: when the record's write_uid already was the writer's (`_filter_not_equal` leaves it clean),
 * the fields stay pending and the window's flush gives the record its uid. Outside a window nothing changes.
 */
export function inDeferredFlush(env: Environment): boolean {
  return DEFERRED.has(env.cr);
}

export function noteRawWrite(env: Environment, model: string, id: number, fields: readonly string[], uidBefore: number | null): void {
  const deferred = DEFERRED.get(env.cr);
  if (!deferred || !fields.length) return;
  const key = `${model},${id}`;
  if (uidBefore !== env.uid || deferred.written.has(key)) { deferred.written.add(key); return; }
  const byId = deferred.pending.get(model) ?? new Map<number, Set<string>>();
  deferred.pending.set(model, byId);
  const set = byId.get(id) ?? new Set<string>();
  byId.set(id, set);
  for (const f of fields) set.add(f);
}

/**
 * A flush of the whole window with `uid` (environments.py:418 `flush_all`, models.py:4008-4011): the records with
 * clean pending writes, recomputed columns or a compute after their INSERT get write_uid = `uid`; the records written
 * explicitly keep their writer's (already in the database). Nothing is dirty afterwards.
 */
async function flushState(env: Environment, state: DeferredState, uid: number): Promise<void> {
  await settle(env, state);
  const byModel = new Map<string, Set<number>>();
  // a record created in the window with a stored computed field Odoo computes after the INSERT (not precomputed, not
  // given) is still dirty at the flush: its `_write_multi` takes the flushing uid, unless an explicit write came later
  for (const [model, ids] of [...[...state.pending].map(([m, b]) => [m, new Set(b.keys())] as const), ...state.recomputed, ...await dirtyCreated(env, state)]) {
    const set = byModel.get(model) ?? new Set<number>();
    byModel.set(model, set);
    for (const id of ids) if (!state.written.has(`${model},${id}`)) set.add(id);
  }
  for (const [model, ids] of byModel) {
    if (ids.size) await runSql(env, sql`UPDATE ${ident(env.reg.model(model).table)} SET "write_uid" = ${uid} WHERE id = ANY(${[...ids]}::int[])`);
  }
  state.pending.clear();
  state.recomputed.clear();
  state.created.clear();
  state.written.clear();
  state.createdDirty.clear();
}

/** The write_uid of the records queries flushed in the window (`flushedAt`): the querying environment's uid. */
async function settle(env: Environment, state: DeferredState): Promise<void> {
  for (const [model, at] of state.flushedAt) {
    const byUid = new Map<number, number[]>();
    for (const [id, uid] of at) byUid.set(uid, [...(byUid.get(uid) ?? []), id]);
    for (const [uid, ids] of byUid) await runSql(env, sql`UPDATE ${ident(env.reg.model(model).table)} SET "write_uid" = ${uid} WHERE id = ANY(${ids}::int[])`);
  }
  state.flushedAt.clear();
}

/**
 * environments.py:387-395 `invalidate_all`: `flush_all` in `env` (its uid is the one the flushed records take), then
 * the cache is empty. A write in progress whose own values are not written yet (base res_company.py:402-405
 * activating the currency: res.groups `_apply_group`, ir_access.py:253) then compares write_uid with nothing: its
 * value is dirty (fields.py `_filter_not_equal`), so it is the writer's. A later write finds the cache fetched again:
 * the database's write_uid, which this flush may have changed (vagb_chart_at: the new company flushed with uid 1 by
 * ir.default's invalidate_all, then written by the chart with uid 2, dirty, kept by `_load_translations`' superuser
 * flush_all; measured with a trace of Odoo). Only inside a `deferredFlush` window, the one place the port models
 * Odoo's flush.
 */
export async function invalidateAll(env: Environment): Promise<void> {
  const state = DEFERRED.get(env.cr);
  if (!state) return;
  await flushState(env, state, env.uid);
  for (const f of state.frames) f.cleared = true;
}

/**
 * The models whose create/write/unlink call `invalidate_all` (before or after their super()): ir_default.py:55-76,
 * ir_access.py:225-249 (`_clear_caches`), res_groups.py:233-235 and :261-263, res_users.py:721-723.
 */
export async function invalidationPoint(env: Environment, model: string, op: "create" | "write" | "unlink", when: "before" | "after", vals?: Readonly<Record<string, unknown>>): Promise<void> {
  const point = model === "ir.default" ? (op === "unlink" ? "after" : "before")
    : model === "ir.access" ? "after"
    : model === "res.groups" && op === "write" ? (when === "before" || !env.su ? when : null)
    : model === "res.users" && op === "write" && vals && "group_ids" in vals ? "after"
    : null;
  if (point !== when) return;
  // the flush computes the related images queued since the last one (a module data file's: src/orm/image_write.ts);
  // lunch's demo flushes its first products' sizes at base.user_demo's group write (res_users.py:721-723)
  const { flushProcessedImages } = await import("./image_write");
  await flushProcessedImages(env);
  if (DEFERRED.has(env.cr)) await invalidateAll(env);
}

/** A `write()` call starts (null outside a `deferredFlush` window); `leaveWrite` when it returns. */
export function enterWrite(env: Environment, model: string, ids: readonly number[]): WriteFrame | null {
  const state = DEFERRED.get(env.cr);
  if (!state) return null;
  const frame: WriteFrame = { model, ids: new Set(ids), cleared: false };
  state.frames.push(frame);
  return frame;
}

export function leaveWrite(env: Environment, frame: WriteFrame | null): void {
  if (!frame) return;
  const frames = DEFERRED.get(env.cr)?.frames;
  const i = frames?.lastIndexOf(frame) ?? -1;
  if (i >= 0) frames!.splice(i, 1);
}

/** Called by `create` with the fields its new records have dirty in Odoo's cache after it (see `createdDirty`). */
export function noteWindowCreate(env: Environment, model: string, fields: ReadonlySet<string>): void {
  const state = DEFERRED.get(env.cr);
  if (!state || !fields.size) return;
  const set = state.createdDirty.get(model) ?? new Set<string>();
  state.createdDirty.set(model, set);
  for (const f of fields) set.add(f);
}

/** Called by `create` for the new records that keep a stored compute to run after the INSERT (see `deferredFlush`). */
export function noteDeferredCreate(env: Environment, model: string, pending: readonly (readonly [number, readonly string[]])[]): void {
  const state = DEFERRED.get(env.cr);
  if (!state || !env.reg.model(model).logAccess) return;
  const byId = state.created.get(model) ?? new Map<number, readonly string[]>();
  for (const [id, fields] of pending) byId.set(id, fields);
  state.created.set(model, byId);
}

/**
 * The created records still dirty at a flush: models.py:4403-4410 `_create` caches None for every stored field not in
 * the INSERT, so a compute's value is dirty unless its `convert_to_cache` is None as well (fields.py
 * `_filter_not_equal`): a Boolean's False and a number's 0 are dirty, an empty many2one, char or selection is not.
 * The port has the computed value in the column. Measured with a trace of Odoo (vagb_chart_lu, 2026-11-14): the sale and
 * purchase journals' `suspense_account_id` computed False stays clean through ir.default's superuser flush, the other
 * journals' `refund_sequence` False is flushed by it.
 */
async function dirtyCreated(env: Environment, state: DeferredState): Promise<[string, Set<number>][]> {
  const out: [string, Set<number>][] = [];
  for (const [model, byId] of state.created) {
    const def = env.reg.model(model);
    const dirty = new Set<number>();
    const check = new Map<string, number[]>();
    for (const [id, fields] of byId) {
      if (fields.some((f) => NONE_NEVER.has(fieldOf(def, f).type))) { dirty.add(id); continue; }
      for (const f of fields) check.set(f, [...(check.get(f) ?? []), id]);
    }
    for (const [f, ids] of check) {
      const todo = ids.filter((id) => !dirty.has(id));
      if (!todo.length || !fieldOf(def, f).column) continue;
      for (const r of await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${todo}::int[]) AND ${ident(f)} IS NOT NULL`)) dirty.add(r.id);
    }
    out.push([model, dirty]);
  }
  return out;
}

/** The field types whose `convert_to_cache` never gives None (fields_misc.py Boolean, fields_numeric.py). */
const NONE_NEVER = new Set(["boolean", "integer", "float", "monetary"]);

/** The Postgres type identifier for a VALUES column cast (fields.py:889 `column_type`, fields_numeric.py:129). */
function columnPgType(field: FieldDef): string {
  if (field.companyDependent || field.translate) return "jsonb";
  if (field.type === "float" && (field.digits !== null || (field.digitsRaw !== undefined && field.digitsRaw !== null))) return "numeric";
  return sqlColumnType(field);
}

export async function writeColumns(env: Environment, def: ModelDef, rows: readonly [number, Record<string, unknown>][], logAccess = true, recomputed = false): Promise<void> {
  const lang = env.lang ?? "en_US";
  const deferred = DEFERRED.get(env.cr);
  // models.py:4014-4027: one UPDATE per group of records; plain writes outside deferredFlush/savepoints are buffered
  // on the cursor (src/pending_writes.ts) so sequential writes and recomputed fields merge into one UPDATE per table
  const canBuf = !deferred && typeof env.cr.canBuffer === "function" && env.cr.canBuffer();
  const bufRows: [number, Map<string, PendingValue>][] = [];
  const bufCache: [number, Map<string, { readonly raw: unknown } | null>][] = [];
  const flushBuffered = (): void => {
    if (!bufRows.length) return;
    env.cr.bufferUpdate(def.table, bufRows.splice(0), bufCache.splice(0));
  };
  const groups = new Map<string, { set: Sql; ids: number[] }>();
  let unique = 0;
  const recordingWritten = isRecordingWritten(env.cr);
  // the records whose write leaves write_uid as it is (see `deferredFlush`)
  if (deferred) await settle(env, deferred);
  const sameUid = deferred && !recomputed && logAccess && def.logAccess && rows.length
    ? new Set((await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${rows.map(([id]) => id)}::int[]) AND write_uid = ${env.uid}`)).map((r) => r.id))
    : null;
  for (const [id, vals] of rows) {
    if (deferred && !recomputed) {
      // a write of no column (translations, x2many) leaves the record as the port's other writes did: its own uid
      // a write in progress across an `invalidate_all` finds no cached write_uid: dirty
      const cleared = deferred.frames.some((f) => f.cleared && f.model === def.name && f.ids.has(id));
      if (sameUid?.has(id) && Object.keys(vals).length && !cleared && !deferred.written.has(`${def.name},${id}`)) {
        const byId = deferred.pending.get(def.name) ?? new Map<number, Set<string>>();
        deferred.pending.set(def.name, byId);
        const fields = byId.get(id) ?? new Set<string>();
        byId.set(id, fields);
        for (const f of Object.keys(vals)) fields.add(f);
      } else deferred.written.add(`${def.name},${id}`);
    }
    // a recomputed column of a record without a dirty write_uid: its write_uid is set at the window's end (the flush),
    // so that a later explicit write still compares with the cached (created) one
    const deferRecomputed = Boolean(deferred && recomputed && !deferred.written.has(`${def.name},${id}`));
    if (deferRecomputed) {
      const set = deferred!.recomputed.get(def.name) ?? new Set<number>();
      deferred!.recomputed.set(def.name, set);
      set.add(id);
    }
    const flushUid = env.uid;
    const entries = Object.entries(vals);
    const bufferable = canBuf && entries.every(([fname, value]) => {
      const field = fieldOf(def, fname);
      if (!field.column) return false;
      if (value instanceof CompanyValue || field.companyDependent) return false;
      if (value instanceof TranslationDict || (field.translate && value !== null)) return false;
      return true;
    });
    if (bufferable) {
      const pendingCols = new Map<string, PendingValue>();
      const cacheCols = new Map<string, { readonly raw: unknown } | null>();
      for (const [fname, value] of entries) {
        const field = fieldOf(def, fname);
        const sqlVal = field.type === "monetary" && typeof value === "number"
          ? await monetaryColumnUpdate(env, def, id, field, value)
          : convertToColumn(field, value, lang);
        pendingCols.set(fname, { kind: "val", sqlVal, pgType: columnPgType(field) });
        cacheCols.set(fname, plainColumn(def, field) ? { raw: sqlVal } : null);
      }
      if (logAccess && def.logAccess) {
        if (!("write_uid" in vals)) {
          pendingCols.set("write_uid", { kind: "val", sqlVal: flushUid, pgType: "int4" });
          cacheCols.set("write_uid", { raw: flushUid });
        }
        if (!("write_date" in vals)) {
          pendingCols.set("write_date", { kind: "now" });
          cacheCols.set("write_date", null);
        }
      }
      if (!pendingCols.size) continue;
      if (recordingWritten) {
        const cachedUid = env.cr.rows.row(def.table, id)?.get("write_uid");
        const curUid = cachedUid !== undefined ? cachedUid : (await runSql<{ u: number | null }>(env, sql`SELECT write_uid AS u FROM ${ident(def.table)} WHERE id = ${id}`))[0]?.u;
        const uidChanges = !("write_uid" in vals) && logAccess && def.logAccess && curUid !== flushUid;
        markWritten(env, def.name, [id], [...Object.keys(vals), ...(logAccess && def.logAccess && !recomputed ? [...(uidChanges ? ["write_uid"] : []), ...(!("write_date" in vals) ? ["write_date"] : [])] : [])]);
      }
      bufRows.push([id, pendingCols]);
      bufCache.push([id, cacheCols]);
      continue;
    }
    flushBuffered();
    const sets: Sql[] = [];
    for (const [fname, value] of entries) {
      const field = fieldOf(def, fname);
      if (!field.column) throw new NotPorted(`column write of ${def.name}.${fname}`);
      if (value instanceof CompanyValue) {
        // models.py:4046-4058: merge the company's value, drop the values equal to each company's fallback
        const patch = value.patch(field);
        sets.push(sql`${ident(fname)} = (SELECT jsonb_object_agg(d.key, d.value) FROM jsonb_each(COALESCE(${ident(def.table)}.${ident(fname)}, '{}'::jsonb) || ${patch}::jsonb) d JOIN jsonb_each(${value.fallbacks}::jsonb) f ON d.key = f.key AND d.value != f.value)`);
        continue;
      }
      if (field.companyDependent) throw new NotPorted(`company_dependent write ${def.name}.${fname}`);
      if (value instanceof TranslationDict) {
        // models.py:4031-4040: partial update, the en_US base from the first value (jsonb key order)
        const keys = Object.keys(value.values).sort((a, b) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0));
        const base = JSON.stringify({ en_US: value.values[keys[0]!] });
        sets.push(sql`${ident(fname)} = COALESCE(${ident(fname)}, ${base}::jsonb) || ${JSON.stringify(value.values)}::jsonb`);
        continue;
      }
      if (field.translate && value !== null) {
        // models.py:4031: COALESCE(col, {'en_US': v}) || {lang: v}
        const partial = JSON.stringify({ [lang]: value });
        const base = JSON.stringify({ en_US: value });
        sets.push(sql`${ident(fname)} = COALESCE(${ident(fname)}, ${base}::jsonb) || ${partial}::jsonb`);
      } else if (field.type === "monetary" && typeof value === "number") {
        sets.push(sql`${ident(fname)} = ${await monetaryColumnUpdate(env, def, id, field, value)}`);
      } else {
        sets.push(sql`${ident(fname)} = ${convertToColumn(field, value, lang)}`);
      }
    }
    if (logAccess && def.logAccess) {
      // models.py:4008-4011 `log_vals | vals`: a computed write_date (product.product) wins over the log value
      if (!("write_uid" in vals) && !deferRecomputed) sets.push(sql`"write_uid" = ${flushUid}`);
      if (!("write_date" in vals)) sets.push(sql`"write_date" = (now() AT TIME ZONE 'UTC')`);
    }
    if (!sets.length) continue;
    // a Store version's written fields (mail/models/models.py `_flush`): the columns this UPDATE flushes
    // (fields.py:1685-1692 `_filter_not_equal`: a write_uid already the flushing user's is not dirty, as measured on
    // Odoo for res.users' OdooBot state written twice by the same user, proofs/scenarios/nt_discuss_odoobot.py); a
    // recomputed field's flush sets write_uid/write_date in SQL only (models.py `_write_multi` log_vals, "not for
    // computed fields"): they are not dirty, as measured for res.users.primary_calendar_id after a user's calendar
    // memberships are deleted (proofs/scenarios/fix_sweep_tail_cal_users.py)
    if (recordingWritten) {
      const uidChanges = !("write_uid" in vals) && !deferRecomputed && logAccess && def.logAccess
        && (await runSql<{ u: number | null }>(env, sql`SELECT write_uid AS u FROM ${ident(def.table)} WHERE id = ${id}`))[0]?.u !== flushUid;
      markWritten(env, def.name, [id], [...Object.keys(vals), ...(logAccess && def.logAccess && !recomputed ? [...(uidChanges ? ["write_uid"] : []), ...(!("write_date" in vals) ? ["write_date"] : [])] : [])]);
    }
    const set = Sql.join(", ", sets);
    const key = groupKey(set) ?? `\u0000${unique++}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, { set, ids: [id] });
    else group.ids.push(id);
  }
  flushBuffered();
  for (const { set, ids } of groups.values()) {
    if (ids.length === 1) await runSql(env, sql`UPDATE ${ident(def.table)} SET ${set} WHERE id = ${ids[0]}`);
    else await runSql(env, sql`UPDATE ${ident(def.table)} SET ${set} WHERE id = ANY(${ids}::int[])`);
  }
}

/** The identity of an assignment list (its text and parameters), or null when a parameter is not a plain value. */
function groupKey(set: Sql): string | null {
  for (const p of set.params) if (p !== null && typeof p !== "string" && typeof p !== "number" && typeof p !== "boolean") return null;
  return `${set.text}\u0000${JSON.stringify(set.params)}`;
}

/**
 * fields.py:1148 `get_column_update` -> Monetary.convert_to_column_insert(value, record) (fields_numeric.py:247-268)
 * for an UPDATE: the record's currency (sudo) rounds the value and formats it with its decimal places.
 */
async function monetaryColumnUpdate(env: Environment, def: ModelDef, id: number, field: FieldDef, value: number): Promise<number | string> {
  const cf = field.currencyField ?? (def.fields.has("currency_id") ? "currency_id" : def.fields.has("x_currency_id") ? "x_currency_id" : null);
  if (cf === null) throw new NotPorted(`monetary field ${def.name}.${field.name} without currency field`);
  const cur = (await new ModelImpl(env.sudo(), def).values([id], def.fields.get(cf)!)).get(id);
  // without a currency the column gets the plain float, which psycopg2 sends as repr(float) ("322.0", not "322")
  if (typeof cur !== "number") return pyFloatRepr(value);
  const row = (await runSql<{ rounding: string | number }>(env, sql`SELECT rounding FROM res_currency WHERE id = ${cur}`))[0];
  if (row === undefined) return pyFloatRepr(value);
  const rounding = Number(row.rounding);
  const digits = Math.max(0, Math.ceil(Math.log10(1 / rounding))); // res_currency.py decimal_places
  return floatRepr(roundMonetary(value, rounding), digits);
}

/**
 * Whether `def.fname` has an inverse in `registry.field_inverses` without a domain (models.py:6401-6403): a one2many
 * of the comodel whose inverse_name is this many2one, or a many2many over the same table.
 */
/**
 * The stored many2one of the comodel that a one2many `def.fname` is the inverse of (fields_relational.py
 * One2many.setup_nonrelated: `field_inverses.add(self, invf)` for a Many2one inverse), else null.
 */
function many2oneInverse(env: Environment, def: ModelDef, fname: string): { def: ModelDef; field: FieldDef } | null {
  const field = def.fields.get(fname);
  if (field?.type !== "one2many" || !field.relation || !field.relationField) return null;
  const co = env.reg.models.get(field.relation);
  const inv = co?.fields.get(field.relationField);
  if (!co || inv?.type !== "many2one" || !inv.store || !inv.column || inv.relation !== def.name) return null;
  return { def: co, field: inv };
}

function hasPlainInverse(env: Environment, def: ModelDef, fname: string): boolean {
  const field = def.fields.get(fname);
  if (!field?.relation) return false;
  const co = env.reg.models.get(field.relation);
  if (!co) return false;
  const plain = (f: FieldDef): boolean => !f.domainCallable && (f.domain === null || f.domain === undefined || (Array.isArray(f.domain) && !f.domain.length));
  for (const f of co.fields.values()) {
    if (f.relation !== def.name) continue;
    if (field.type === "many2one" && f.type === "one2many" && f.relationField === fname && plain(f)) return true;
    if (field.type === "many2many" && f.type === "many2many" && field.relationTable && f.relationTable === field.relationTable && f !== field && plain(f)) return true;
  }
  return false;
}

/**
 * When another mail.thread model has an open write, open a tracking level of `model` (so the per-record writes of the
 * recompute only snapshot) and return the function that hands its closing to the open model's `afterTracking`.
 */
async function deferredTrackingScope(env: Environment, model: string): Promise<(() => Promise<void>) | null> {
  const tracking = await import("../mail/tracking");
  const open = tracking.openTrackingModel(env.cr, model);
  if (!open || tracking.trackDepth(env.cr, model) > 0 || !(await tracking.trackedFields(env, model)).length) return null;
  await tracking.trackPrepare(env, model, []); // opens a nesting level without snapshotting
  return async () => {
    const { closeTrackingScope } = await import("../mail/write_hooks");
    tracking.afterTracking(env.cr, open, () => closeTrackingScope(env, model));
  };
}

/**
 * A datetime field's value as Odoo's cache holds it: read from its column with the microseconds (fields_temporal.py
 * `to_datetime` of the psycopg value). The ORM's values drop the fraction (they are what `read` returns); a compute
 * that passes such a value on (a min or a copy) gets it back as a PreciseDatetime when the column has one and the
 * record's value is the column's (not an in-memory one).
 */
export async function preciseDatetime(rec: Rec, name: string): Promise<unknown> {
  const value = await rec.get(name);
  if (typeof value !== "string" || !value || rec.id === null) return value;
  const def = rec.def;
  const field = def.fields.get(name);
  if (!field?.column) return value;
  const raw = (await runSql<{ v: string | null }>(rec.env, sql`SELECT ${ident(field.name)}::text AS v FROM ${ident(def.table)} WHERE id = ${rec.id}`))[0]?.v ?? null;
  if (!raw || !raw.includes(".") || raw.slice(0, 19).replace("T", " ") !== value) return value;
  return new PreciseDatetime(raw);
}
