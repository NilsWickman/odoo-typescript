/**
 * `BaseModel.write` (odoo/odoo/orm/models.py:3805-3991), `_write_multi` (:3997), `_parent_store_update_prepare` /
 * `_parent_store_update` (:4484-4550), x2many `write_batch` (fields_relational.py:1032-1105 one2many,
 * :1457-1620 many2many), inverses and `_validate_fields` (:1299). The registry of per-model Python overrides
 * (`create`/`write`/`unlink`/`copy_data` super() chains, inverse and constraint methods) lives here.
 */
import { withoutFlush } from "./flush_points";
import { checkCompany, checkCompanyAuto } from "./check_company";
import { isImageMixinSource, writeImageMixin } from "./image_write";
import { AccessError, MissingError, NotPorted, UserError } from "../errors";
import { accessDomain, checkModelAccess } from "./access";
import { type Command, OdooValueError, parseCommands } from "./commands";
import { cacheEqual, convertToCache, referenceValue, roundMonetary } from "./convert";
import { plainNumber } from "./values";
import { normalizeVals } from "./compiled_vals";
import { create, LOG_ACCESS_COLUMNS, coComputed, sanitizeAnalytic } from "./create";
import * as D from "./domain";
import { genModelFields } from "./genmeta";
import { hooksOf } from "./hooks";
import { ModelImpl } from "./model";
import { emptyValue, enterWrite, invalidateOverlay, invalidationPoint, isComputed, leaveWrite, RecomputeQueue, setOverlay, writeColumns } from "./recompute";
import { checkTermTranslationWrite, writeValue } from "./write_values";
import { checkFieldAccess, ident, queryIds, runSql, searchQuery, sql } from "./sql";
import type { Environment, FieldDef, ModelDef } from "./types";
import { unlink } from "./unlink";
import { keyed } from "./keys";
import { rememberX2manyOrder } from "./x2many_order";

type CreateFn = (env: Environment, valsList: Record<string, unknown>[]) => Promise<number[]>;
export type WriteFn = (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>;
type UnlinkFn = (env: Environment, ids: readonly number[]) => Promise<void>;

/**
 * Python `repr` of a field's literal `domain=` (fields_relational.py:1073 formats `comodel_domain` with an f-string): the
 * generated metadata keeps it as JSON lists, and the leaves of a domain literal in the source are tuples.
 */
function fieldDomainRepr(domain: unknown): string {
  if (!Array.isArray(domain)) return D.pyRepr(domain);
  return `[${domain.map((leaf) => (Array.isArray(leaf) && leaf.length === 3 && typeof leaf[0] === "string" ? `(${leaf.map((x) => D.pyRepr(x)).join(", ")})` : D.pyRepr(leaf))).join(", ")}]`;
}

/** A model's Python overrides; `next` is `super()`. */
export interface ModelOverrides {
  readonly create?: (env: Environment, valsList: Record<string, unknown>[], next: CreateFn) => Promise<number[]>;
  readonly write?: (env: Environment, ids: readonly number[], vals: Record<string, unknown>, next: WriteFn) => Promise<void>;
  /** `@api.ondelete` methods and unlink overrides, run before the DELETE. */
  readonly beforeUnlink?: UnlinkFn;
  /** An `unlink` override above mail.thread's (Python MRO: the model's own class first); `next` is `super().unlink()`
   *  (mail.thread's steps, the `@api.ondelete` methods, the ORM core). */
  readonly unlink?: (env: Environment, ids: readonly number[], next: UnlinkFn) => Promise<void>;
  /** `copy_data` override: adjusts the values of the copies (vals_list, one per id); `defaults` as the caller gave them. */
  readonly copyData?: (env: Environment, ids: readonly number[], valsList: Record<string, unknown>[], defaults: Readonly<Record<string, unknown>>) => Promise<void>;
  /** The `default` a `copy_data` override passes to `super()` (sale.order: `order_line` set to [] first). */
  readonly copyDefaults?: (defaults: Readonly<Record<string, unknown>>) => Record<string, unknown>;
  /** Inverse methods by field (`inverse=`), called with the records whose field was set. */
  readonly inverse?: Readonly<Record<string, (env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>) => Promise<void>>>;
  /** `@api.constrains(fields)` methods. */
  readonly constraints?: readonly { readonly fields: readonly string[]; readonly fn: (env: Environment, ids: readonly number[]) => Promise<void> }[];
  /** `default_get` override, applied to the generic result. */
  readonly defaultGet?: (env: Environment, fields: readonly string[], values: Record<string, unknown>) => Promise<void>;
  /** `name_create` override. */
  readonly nameCreate?: (env: Environment, name: string) => Promise<[number, string] | false>;
  /** The `write` override does not reach `super()` for these values (mail_alias_mixin_optional.py:126-127 with only
   *  alias fields): BaseModel.write's access checks and the classes below it (mail.thread, the hooks) do not run. */
  readonly skipsCore?: (vals: Readonly<Record<string, unknown>>) => boolean;
}

const OVERRIDES = new Map<string, ModelOverrides>();

/** The model field (`model_field=`) of the res_id many2one_reference of the mail models (mail_activity.py,
 *  mail_message.py, mail_followers.py, ir_attachment.py). */
const REFERENCE_MODEL_FIELD: Readonly<Record<string, string>> = {
  "mail.activity": "res_model", "mail.message": "model", "mail.followers": "res_model", "ir.attachment": "res_model",
};

/** Wrap the overrides under their registry keys (src/orm/keys.ts). */
function keyedOverrides(model: string, o: ModelOverrides, prev: ModelOverrides | undefined): ModelOverrides {
  const out: Record<string, unknown> = { ...o };
  const one = (k: "create" | "write" | "unlink" | "beforeUnlink" | "copyData" | "defaultGet" | "nameCreate"): void => {
    const fn = o[k];
    if (fn !== undefined) out[k] = keyed(`override.${k}`, model, "*", fn);
  };
  one("create"); one("write"); one("unlink"); one("beforeUnlink"); one("copyData"); one("defaultGet"); one("nameCreate");
  if (o.inverse) out["inverse"] = Object.fromEntries(Object.entries(o.inverse).map(([f, fn]) => [f, keyed("override.inverse", model, f, fn)]));
  const base = prev?.constraints?.length ?? 0;
  if (o.constraints) out["constraints"] = o.constraints.map((c, i) => ({ ...c, fn: keyed("override.constraint", model, `#${base + i}`, c.fn) }));
  return out as ModelOverrides;
}

export function registerOverrides(model: string, raw: ModelOverrides): void {
  const prev = OVERRIDES.get(model);
  const o = keyedOverrides(model, raw, prev);
  if (!prev) { OVERRIDES.set(model, o); return; }
  OVERRIDES.set(model, {
    ...prev, ...o,
    inverse: { ...prev.inverse, ...o.inverse },
    constraints: [...(prev.constraints ?? []), ...(o.constraints ?? [])],
  });
}

export function overridesOf(model: string): ModelOverrides {
  return OVERRIDES.get(model) ?? {};
}

/** Fields with `inverse=` (gen/out[/<template>]/models.json `inverse`, extracted from the Python source). */
export async function inverseFields(env: Environment, model: string): Promise<Set<string>> {
  const fields = await genModelFields(env, model);
  return new Set(Object.entries(fields).filter(([, f]) => f.inverse).map(([k]) => k));
}

/** models.py:4211 determine_inverse for the given fields. */
/** `vals` are the written values: a non-stored inverse field's value only lives in Odoo's cache, here in `vals`. */
export async function runInverses(env: Environment, def: ModelDef, ids: readonly number[], names: readonly string[], vals: Readonly<Record<string, unknown>> = {}): Promise<void> {
  const inv = overridesOf(def.name).inverse ?? {};
  const done = new Set<unknown>();
  for (const name of names) {
    const fn = inv[name];
    const field = def.fields.get(name);
    if (!fn && field?.related && !field.inheritedFrom) {
      // fields.py:799-813 _inverse_related: assign the value on the first record at the end of the path; nothing to
      // do when the path is empty for every record (the value itself is not at hand here)
      const path = field.related.split(".");
      let cur = [...ids];
      let m = def;
      for (const step of path.slice(0, -1)) {
        const f = m.fields.get(step);
        // a one2many step (traverse_related's `first(record[name])`): only when no row points at the records, its
        // target empty for certain (any comodel row with the inverse value, whatever the field's domain or active)
        if (f && f.type === "one2many" && f.relation && f.relationField) {
          const co = env.reg.model(f.relation), inv = co.fields.get(f.relationField);
          if (!inv) throw new NotPorted(`inverse of related ${def.name}.${name} (inverse field ${f.relationField})`);
          const modelField = inv.type === "many2one_reference" ? REFERENCE_MODEL_FIELD[co.name] : undefined;
          const any = await runSql<{ one: number }>(env, modelField
            ? sql`SELECT 1 AS one FROM ${ident(co.table)} WHERE ${ident(f.relationField)} = ANY(${cur}::int[]) AND ${ident(modelField)} = ${m.name} LIMIT 1`
            : sql`SELECT 1 AS one FROM ${ident(co.table)} WHERE ${ident(f.relationField)} = ANY(${cur}::int[]) LIMIT 1`);
          if (any.length) throw new NotPorted(`inverse of related ${def.name}.${name} through the one2many ${step}`);
          cur = [];
          break;
        }
        if (!f || f.type !== "many2one" || !f.relation || !f.column) throw new NotPorted(`inverse of related ${def.name}.${name}`);
        const rows = await runSql<{ v: number | null }>(env, sql`SELECT ${ident(step)} AS v FROM ${ident(m.table)} WHERE id = ANY(${cur}::int[])`);
        cur = rows.map((r) => r.v).filter((v): v is number => v !== null);
        m = env.reg.model(f.relation);
        if (!cur.length) break;
      }
      if (cur.length) {
        // :812-813 `target[field.name] = value` on the first target of each record: a full write (fields.py:2025-2028)
        if (!(name in vals) || ids.length !== 1 || cur.length !== 1) throw new NotPorted(`inverse of related ${def.name}.${name} with a target record`);
        await write(env, m.name, cur, { [path[path.length - 1]!]: vals[name] });
      }
      continue;
    }
    if (!fn) throw new NotPorted(`inverse of ${def.name}.${name}`);
    if (done.has(fn)) continue;
    done.add(fn);
    await fn(env, ids, vals);
  }
}

/** models.py:1299 _validate_fields: constraint methods whose fields intersect, run as superuser. */
export async function validateFields(env: Environment, def: ModelDef, ids: readonly number[], names: readonly string[], excluded: readonly string[] = []): Promise<void> {
  const set = new Set(names), ex = new Set(excluded);
  for (const c of overridesOf(def.name).constraints ?? []) {
    if (c.fields.some((f) => set.has(f)) && !c.fields.some((f) => ex.has(f))) await c.fn(env.sudo(), ids);
  }
  if (def.parentStore && set.has(def.parentName)) return; // the loop check is in parentStoreUpdate (models.py:4519)
}

/** The public `write(vals)`: hooks (mail.thread tracking), model overrides, then the ORM core. */
export async function write(env: Environment, model: string, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;
  // values from compiled code in the RPC layer's form before any hook reads them (orm/compiled_vals.ts)
  normalizeVals(env, model, vals);
  // Odoo's write_uid cache across this call (src/orm/recompute.ts `deferredFlush`)
  const frame = enterWrite(env, model, ids);
  try {
    await writeInner(env, model, ids, vals);
  } finally {
    leaveWrite(env, frame);
  }
}

async function writeInner(env: Environment, model: string, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  const def = env.reg.model(model);
  const own = overridesOf(model);
  if (own.write && own.skipsCore?.(vals)) {
    // the override answers without BaseModel.write: no access check, no hook of the classes below it
    await checkExisting(env, def, ids, "write");
    await own.write(env, ids, vals, (e, i, v) => writeCore(e, model, i, v));
    return;
  }
  // the overrides read the records first (mail.track.mixin `_track_prepare`, res.partner pre-values): a deleted
  // record raises MissingError before anything else (fields.py:1886, PORTING_odoo.md 12.18)
  if (!env.su) await checkModelAccess(env, def, "write"); // no permission at all: AccessError first (models.py:3828)
  const hooks = hooksOf(model).write ?? [];
  if (!hooks.length && !overridesOf(model).write) {
    // no override reads the records first: BaseModel.write (models.py:3849-3854) runs check_access('write'), which
    // only looks at the records when the access domain is neither TRUE nor FALSE (models.py:3496-3502), then the
    // field names (unknown name: ValueError) before anything touches the rows
    const domain = env.su ? D.TRUE : await accessDomain(env, def, "write");
    let accessible = true;
    if (domain.kind !== "true") {
      await checkExisting(env, def, ids, "write");
      // forbidden records: writeCore raises the record AccessError (before its field checks), as check_access does
      const allowed = await queryIds(await searchQuery(env, def, D.cond("id", "in", [...ids]), { activeTest: false, secDomain: domain }));
      accessible = new Set(allowed).size === new Set(ids).size;
    }
    if (accessible) {
      for (const name of Object.keys(vals)) {
        const field = def.fields.get(name);
        if (!field) throw new OdooValueError(`Invalid field '${name}' in '${model}'`);
      }
    }
  }
  await checkExisting(env, def, ids, "write");
  let old: Map<number, Record<string, unknown>> | null = null;
  if (hooks.some((h) => h.afterWrite)) old = await withoutFlush(env.cr, () => snapshot(env, def, ids, Object.keys(vals)));
  for (const h of hooks) if (h.beforeWrite) await h.beforeWrite(env, ids, vals);
  const override = overridesOf(model).write;
  await invalidationPoint(env, model, "write", "before", vals);
  if (override) await override(env, ids, vals, (e, i, v) => writeCore(e, model, i, v));
  else await writeCore(env, model, ids, vals);
  await invalidationPoint(env, model, "write", "after", vals);
  for (const h of hooks) if (h.afterWrite) await h.afterWrite(env, ids, vals, old ?? new Map());
}

/** Old values (cache format) of `names` for `ids`, read as superuser. */
export async function snapshot(env: Environment, def: ModelDef, ids: readonly number[], names: readonly string[]): Promise<Map<number, Record<string, unknown>>> {
  const out = new Map<number, Record<string, unknown>>(ids.map((id) => [id, {}]));
  const m = new ModelImpl(env.sudo().withContext({ ...env.context, active_test: false }), def);
  for (const name of names) {
    const f = def.fields.get(name);
    if (!f) continue;
    const values = await m.values(ids, f);
    for (const id of ids) out.get(id)![name] = values.get(id) ?? emptyValue(f);
  }
  return out;
}

async function checkExisting(env: Environment, def: ModelDef, ids: readonly number[], operation: string): Promise<void> {
  // rows read in this transaction and not deleted since exist: the statement would find them all (src/sql_cache.ts)
  if (ids.length && env.cr.rows.allExist(def.table, ids)) return;
  const rows = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[])`);
  if (rows.length === new Set(ids).size) return;
  const found = new Set(rows.map((r) => r.id));
  const missing = [...new Set(ids)].filter((id) => !found.has(id));
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated MissingError (${env.lang})`);
  // models.py:3572 (check_access -> _check_access): MissingError for deleted records (PORTING_odoo.md 12.18)
  throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${def.name}(${missing[0]},), User: ${env.uid})`);
}

/**
 * The access checks at the start of BaseModel.write (models.py:3848-3854): `check_access('write')`, then
 * `check_field_access(field, 'write')` for every written field. Also used by write overrides that refuse after them
 * (src/mail/write_hooks.ts), so that the caller gets Odoo's AccessError first.
 */
export async function checkWriteAccess(env: Environment, model: string, ids: readonly number[], names: readonly string[]): Promise<void> {
  const def = env.reg.model(model);
  if (!env.su) {
    // mail_thread.py write -> `_track_prepare(self._fields)` reads the tracked fields before BaseModel.write
    if ([...def.fields.values()].some((f) => f.tracking !== null) && !env.context["tracking_disable"] && !env.context["mail_notrack"]) {
      await checkModelAccess(env, def, "read");
      await checkExisting(env, def, ids, "read");
    }
    await checkModelAccess(env, def, "write");
    await checkExisting(env, def, ids, "write");
    await new ModelImpl(env, def).checkAccess(ids, "write");
  }
  for (const name of names) {
    const field = def.fields.get(name);
    if (!field) throw new OdooValueError(`Invalid field '${name}' in '${model}'`);
    await checkFieldAccess(env, def, field, "write");
  }
}

/** models.py:3805 BaseModel.write. */
export async function writeCore(env: Environment, model: string, ids: readonly number[], valsIn: Record<string, unknown>): Promise<void> {
  if (!ids.length) return;
  const def = env.reg.model(model);
  await checkWriteAccess(env, model, ids, Object.keys(valsIn));
  const bad = new Set(["id", "parent_path", ...(def.logAccess ? LOG_ACCESS_COLUMNS : [])]);
  const vals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(valsIn)) if (!bad.has(k)) vals[k] = v;
  await sanitizeAnalytic(env, model, vals);
  const inverses = await inverseFields(env, model);

  // models.py:3871-3893: protected fields and inverse grouping
  const queue = new RecomputeQueue(env);
  const protectedFields = new Set<string>();
  for (const name of Object.keys(vals)) {
    const field = def.fields.get(name)!;
    if (inverses.has(name) || (isComputed(field) && !field.readonly)) {
      if (field.store || (field.type !== "one2many" && field.type !== "many2many")) for (const f of coComputed(def, field)) protectedFields.add(f);
    }
  }
  queue.protect(model, protectedFields, ids);
  // models.py:3905 `with env.protecting(protected, self)`: also for the writes and creates nested in this one
  await queue.protecting(async () => {

  // parent_store: records whose parent changes (models.py:4484)
  const parentRecords = def.parentStore && def.parentName in vals ? await parentStoreUpdatePrepare(env, def, ids, vals[def.parentName]) : [];

  // field.write per field (fields.py write -> cache, flushed by _write_multi)
  const columnVals: Record<string, unknown> = {};
  const special: FieldDef[] = [];
  const overlays: [string, unknown][] = [];
  const relatedWrites: [FieldDef, unknown][] = [];
  const inherited = new Map<string, Record<string, unknown>>();
  const x2many: [FieldDef, Command[]][] = [];
  const nonStoredM2m: [FieldDef, Command[]][] = [];
  let imageMixin: { value: unknown } | null = null;
  for (const [name, value] of Object.entries(vals)) {
    const field = def.fields.get(name)!;
    if (field.type === "one2many" || field.type === "many2many") {
      if (!field.store && field.related && !field.readonly && !field.inheritedFrom && !overridesOf(model).inverse?.[name]) {
        // fields.py:799-813 _inverse_related of an x2many: the record's value after the commands (its cache), assigned on
        // the target, which writes it as [Command.set(ids)] (convert_to_write). A SET or a CLEAR gives that value
        // whatever the current one; other commands apply to the current value (not ported)
        const cmds = parseCommands(value, `${model}.${name}`);
        const only = cmds.length === 1 ? cmds[0]! : null;
        if (only?.op === "set") relatedWrites.push([field, [[6, 0, [...only.ids]]]]);
        else if (only?.op === "clear") relatedWrites.push([field, [[6, 0, []]]]);
        else throw new NotPorted(`write of the related x2many ${model}.${name} with commands other than one SET or CLEAR`);
        continue;
      }
      if (!field.store && field.type === "many2many" && inverses.has(name) && overridesOf(model).inverse?.[name]) {
        // fields_relational.py:1457-1560 Many2many.write_batch of a non-stored field: the commands apply to the records'
        // current value as the user sees it (`records[self.name]`, no sudo), the result only goes in cache (here the
        // overlay the inverse reads); nothing is written to a relation table
        nonStoredM2m.push([field, parseCommands(value, `${model}.${name}`)]);
        continue;
      }
      if (!field.store) throw new NotPorted(`write of non-stored x2many ${model}.${name}`);
      x2many.push([field, parseCommands(value, `${model}.${name}`)]);
    } else if (field.inheritedFrom && field.inheritedVia) {
      // `_inherits`: the delegated field is a related field whose inverse writes the parent (fields.py _inverse_related)
      const pv = inherited.get(field.inheritedFrom) ?? {};
      pv[name] = value;
      inherited.set(field.inheritedFrom, pv);
    } else if (field.column) {
      if (field.companyDependent || field.translate || field.type === "monetary" || field.type === "html") special.push(field);
      else columnVals[name] = convertToCache(field, field.type === "reference" ? await referenceValue(env, value) : value, model);
    } else if (isImageMixinSource(def, field)) {
      imageMixin = { value };
    } else if ((field.type === "binary" || field.type === "image") && field.attachment) {
      if (value) {
        // Image fields go through image_process (fields_binary.py Image._image_process, tools/image.py:289): Pillow
        // decoding, LANCZOS resizing and re-encoding (libjpeg, zlib) for every size of image.mixin, which the port
        // cannot reproduce byte for byte; the plain Binary attachment write is not ported either.
        throw new NotPorted(field.type === "image"
          ? `write of image field ${model}.${name} (Pillow resize/re-encode is not reproducible bit-exactly in the Worker)`
          : `write of attachment field ${model}.${name}`);
      }
      const existing = await runSql<{ id: number }>(env, sql`SELECT id FROM ir_attachment WHERE res_model = ${model} AND res_field = ${name} AND res_id = ANY(${[...ids]}::int[])`);
      if (existing.length) throw new NotPorted(`clearing attachment field ${model}.${name}`);
    } else if (!field.store && field.related && !field.readonly && !field.inheritedFrom && !overridesOf(model).inverse?.[name]) {
      // fields.py _inverse_related (:799-813): assign the value on the record at the end of the path
      relatedWrites.push([field, value]);
    } else if (!field.store && inverses.has(name)) {
      // non-stored inverse fields are only put in cache before the inverse runs
    } else if (!field.store && isComputed(field) && field.type !== "binary" && field.type !== "image") {
      // fields.py write on a non-stored computed (or readonly related) field without inverse: the value only lives
      // in the transaction cache
      overlays.push([name, convertToCache(field, value, model)]);
    } else {
      throw new NotPorted(`write of field ${model}.${name}`);
    }
  }
  // the new cache value of each non-stored many2many (fields_relational.py:1484-1560): the old one as read, then the
  // commands in order; inactive linked records (`old_inactive_relation`, kept beside) refuse
  const nonStoredValues: [FieldDef, Map<number, number[]>][] = [];
  for (const [field, commands] of nonStoredM2m) {
    const current = await new ModelImpl(env, def).values(ids, field);
    const co = env.reg.model(field.relation!);
    const next = new Map<number, number[]>();
    for (const id of ids) {
      let rel = [...((current.get(id) as number[] | undefined) ?? [])];
      for (const c of commands) {
        if (c.op === "link") { if (!rel.includes(c.id)) rel.push(c.id); }
        else if (c.op === "unlink") rel = rel.filter((x) => x !== c.id);
        else if (c.op === "set") rel = [...new Set(c.ids)];
        else if (c.op === "clear") rel = [];
        else throw new NotPorted(`write of the non-stored many2many ${model}.${field.name} with a ${c.op} command`);
      }
      next.set(id, rel);
    }
    const linked = [...new Set([...current.values()].flatMap((v) => (v as number[] | undefined) ?? []))];
    if (co.fields.has("active") && linked.length) {
      const inactive = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(co.table)} WHERE id = ANY(${linked}::int[]) AND active IS NOT TRUE LIMIT 1`);
      if (inactive.length) throw new NotPorted(`write of the non-stored many2many ${model}.${field.name} with an inactive linked record`);
    }
    nonStoredValues.push([field, next]);
  }
  // models.py:3907-3930 `modified(fnames_modifying_relations, before=True)`: the records reached through the old
  // value of a relational field (a line leaving its order) are marked before the write
  const relational = Object.keys(vals).filter((n) => {
    const f = def.fields.get(n);
    return f !== undefined && f.store && (f.type === "many2one" || f.type === "many2many" || f.type === "one2many");
  });
  if (relational.length) await queue.modified(model, ids, relational);
  // models.py:3997 _write_multi: one UPDATE per record, only changed values are flushed
  const rows: [number, Record<string, unknown>][] = [];
  for (const id of ids) {
    const row: Record<string, unknown> = { ...columnVals };
    // monetary values are rounded with each record's currency, company-dependent ones are per company
    for (const field of special) {
      const cache = await writeValue(env, def, field, vals[field.name], vals, id);
      if (await checkTermTranslationWrite(env, def, field, [id], cache)) continue;
      row[field.name] = cache;
    }
    rows.push([id, row]);
  }
  await writeColumns(env, def, rows);
  invalidateOverlay(env, def, ids, Object.keys(vals));
  for (const [name, v] of overlays) setOverlay(env, model, name, ids, v);
  for (const [field, values] of nonStoredValues) for (const [id, v] of values) setOverlay(env, model, field.name, [id], v);
  for (const [field, value] of relatedWrites) {
    const path = field.related!.split(".");
    let cur = new Map<number, number | null>(ids.map((id) => [id, id]));
    let m = def;
    let empty = false;
    for (const step of path.slice(0, -1)) {
      const f = m.fields.get(step);
      // a one2many step (fields.py traverse_related `first(record[name])`): only when no row points at the records,
      // the target being empty for certain (any comodel row with the inverse value, whatever the domain or active)
      if (f && f.type === "one2many" && f.relation && f.relationField) {
        const co = env.reg.model(f.relation);
        const at = [...new Set([...cur.values()].filter((v): v is number => typeof v === "number"))];
        // a many2one_reference inverse (res_id) points at records of the model its model field names
        const modelField = co.fields.get(f.relationField)?.type === "many2one_reference" ? REFERENCE_MODEL_FIELD[co.name] : undefined;
        const any = await runSql<{ one: number }>(env, modelField
          ? sql`SELECT 1 AS one FROM ${ident(co.table)} WHERE ${ident(f.relationField)} = ANY(${at}::int[]) AND ${ident(modelField)} = ${m.name} LIMIT 1`
          : sql`SELECT 1 AS one FROM ${ident(co.table)} WHERE ${ident(f.relationField)} = ANY(${at}::int[]) LIMIT 1`);
        if (any.length) throw new NotPorted(`inverse of related ${model}.${field.name} through the one2many ${step}`);
        empty = true;
        break;
      }
      if (!f || f.type !== "many2one" || !f.relation) throw new NotPorted(`inverse of related ${model}.${field.name}`);
      const vals2 = await new ModelImpl(env.sudo(), m).values([...new Set([...cur.values()].filter((v): v is number => typeof v === "number"))], f);
      cur = new Map([...cur].map(([id, v]) => [id, v === null ? null : (vals2.get(v) as number | null) ?? null]));
      m = env.reg.model(f.relation);
    }
    if (empty) continue;
    const targets = [...new Set([...cur.values()].filter((v): v is number => typeof v === "number"))];
    if (targets.length) await write(env, m.name, targets, { [path[path.length - 1]!]: value });
  }
  for (const [parentModel, pvals] of inherited) {
    const link = def.inherits.get(parentModel);
    if (!link) throw new NotPorted(`inherited field without _inherits link (${model} -> ${parentModel})`);
    const parents = await new ModelImpl(env.sudo(), def).values(ids, def.fields.get(link)!);
    const pids = [...new Set([...parents.values()].filter((v): v is number => typeof v === "number"))];
    await write(env, parentModel, pids, pvals);
  }
  for (const [field, commands] of x2many) await writeX2many(env, def, field, ids, commands, false);
  if (parentRecords.length) await parentStoreUpdate(env, def, parentRecords);
  // image.mixin: image_1920 and its stored related sizes are written here (src/orm/image_write.ts), so the recompute
  // queue does not see image_1920 as modified
  if (imageMixin) await writeImageMixin(env, def, ids, imageMixin.value);

  // models.py:3862-3863, :3942: write() sets write_date before `modified(vals)`, so fields depending on it follow
  // (product.product `_compute_write_date`, product_product.py:252-273, the only one in the templates)
  await queue.modified(model, ids, [...Object.keys(vals).filter((n) => !(imageMixin && n === "image_1920")), ...(def.logAccess && !("write_date" in vals) ? ["write_date"] : [])]);
  await queue.run();

  // `_inherits` fields: their `_inverse_related` (fields.py:675-676, :799-813) is the parent write above
  const inverseNames = Object.keys(vals).filter((n) => inverses.has(n) && !def.fields.get(n)?.inheritedFrom
    && !relatedWrites.some(([f]) => f.name === n));
  await validateFields(env, def, ids, Object.keys(vals), inverseNames);
  if (inverseNames.length) await runInverses(env, def, ids, inverseNames, vals);
  await validateFields(env, def, ids, inverseNames);
  });
  // models.py:3989-3990 `_check_company(list(vals))` of the models with `_check_company_auto`
  if (await checkCompanyAuto(env, model)) await checkCompany(env, def, ids, Object.keys(valsIn));
}

/** models.py:4484 _parent_store_update_prepare: the records whose parent actually changes. */
async function parentStoreUpdatePrepare(env: Environment, def: ModelDef, ids: readonly number[], value: unknown): Promise<number[]> {
  const parent = convertToCache(def.fields.get(def.parentName)!, value, def.name) as number | null;
  const p = ident(def.parentName);
  const cond = parent ? sql`(${p} != ${parent} OR ${p} IS NULL)` : sql`${p} IS NOT NULL`;
  const rows = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[]) AND ${cond} ORDER BY id`);
  return rows.map((r) => r.id);
}

/** models.py:4519 _parent_store_update, with the loop check (PORTING_odoo.md 12.12). */
async function parentStoreUpdate(env: Environment, def: ModelDef, ids: readonly number[]): Promise<void> {
  const t = ident(def.table);
  const rows = await runSql<{ id: number; parent: number | null; path: string | null }>(env,
    sql`SELECT n.id, n.${ident(def.parentName)} AS parent, p.parent_path AS path FROM ${t} n LEFT JOIN ${t} p ON p.id = n.${ident(def.parentName)} WHERE n.id = ANY(${[...ids]}::int[])`);
  const groups = new Map<string, number[]>();
  for (const r of rows) groups.set(r.path ?? "", [...(groups.get(r.path ?? "") ?? []), r.id]);
  for (const [prefix, recIds] of groups) {
    if (prefix) {
      const parentIds = new Set(prefix.split("/").slice(0, -1).map(Number));
      if (recIds.some((id) => parentIds.has(id))) {
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated parent loop error (${env.lang})`);
        throw new UserError(`You are creating a loop in your '${def.description}' records. A record cannot be a child of itself or one of its own sub-items. Please select a different parent.`);
      }
    }
    await runSql(env, sql`UPDATE ${t} child SET parent_path = concat(${prefix}::text, substr(child.parent_path, length(node.parent_path) - length(node.id || '/') + 1))
      FROM ${t} node WHERE node.id = ANY(${recIds}::int[]) AND child.parent_path >= node.parent_path AND child.parent_path < left(node.parent_path, -1) || '0'`);
  }
}

/** The comodel environment of an x2many write: field context, `_check_sudo_commands` (fields_relational.py:834). */
function comodelEnv(env: Environment, field: FieldDef): Environment {
  const ctx = { ...env.context, ...field.context };
  // res.partner `_allow_sudo_commands = False` (res_partner.py:275): sudo is dropped on the comodel
  const co = env.reg.model(field.relation!);
  const e = env.withContext(ctx);
  return NO_SUDO_COMMANDS.has(co.name) && e.su ? e.withUser(e.uid) : e;
}

const NO_SUDO_COMMANDS = new Set(["res.partner", "res.users", "res.groups", "ir.attachment"]);

/** fields_relational.py:1032 One2many.write_batch / :1457 Many2many.write_batch on real records. */
export async function writeX2many(env: Environment, def: ModelDef, field: FieldDef, ids: readonly number[], commands: readonly Command[], creating: boolean): Promise<void> {
  if (!field.relation) throw new NotPorted(`x2many without comodel ${def.name}.${field.name}`);
  const coEnv = comodelEnv(env, field);
  const co = coEnv.reg.model(field.relation);
  // fields_relational.py:1588-1594: Many2many.write_batch checks read access on the added lines, also when the
  // commands add none (`browse().check_access('read')` is the model's ACL): a user without access to the comodel
  // cannot write the field, not even an empty list
  const checkAddedRead = async (added: readonly number[]): Promise<void> => {
    if (env.su) return;
    try {
      await new ModelImpl(coEnv.withContext({ ...coEnv.context, active_test: false }), co).checkAccess([...new Set(added)], "read");
    } catch (e) {
      if (e instanceof AccessError) throw new AccessError(`Failed to write field ${def.name}.${field.name}\n${e.message}`);
      throw e;
    }
  };
  if (!commands.length) {
    if (field.type === "many2many") await checkAddedRead([]);
    return;
  }
  const domain = Array.isArray(field.domain) ? D.parseDomain(field.domain) : D.TRUE;
  // fields_relational.py:91-101 get_comodel_domain: a string domain is client-side only (Domain.TRUE here)
  if (field.domain && !Array.isArray(field.domain) && (typeof field.domain !== "string" || field.domainCallable)) {
    throw new NotPorted(`x2many domain ${def.name}.${field.name}`);
  }
  const coModel = new ModelImpl(coEnv, co);
  /** `len(lines.filtered_domain(comodel_domain)) < len(lines)` -> ValueError (fields_relational.py:1073). */
  const checkDomain = async (lineIds: readonly number[]): Promise<void> => {
    if (!lineIds.length || domain.kind === "true") return;
    const ok = await new ModelImpl(coEnv.sudo().withContext({ ...coEnv.context, active_test: false }), co).search(D.and([D.cond("id", "in", [...lineIds]), domain]));
    if (ok.length < new Set(lineIds).size) throw new OdooValueError(`Cannot link inaccessible records in ${def.name}.${field.name} (${fieldDomainRepr(field.domain)})`);
  };

  if (field.type === "one2many") {
    const inverse = field.relationField;
    if (!inverse) throw new NotPorted(`one2many without inverse ${def.name}.${field.name}`);
    const inverseField = co.fields.get(inverse)!;
    if (inverseField.type !== "many2one") throw new NotPorted(`one2many over ${inverseField.type} ${def.name}.${field.name}`);
    const cascade = inverseField.ondelete === "cascade";
    const toCreate: Record<string, unknown>[] = [];
    const toDelete: number[] = [];
    const toLink = new Map<number, number[]>();
    let allowFullDelete = !creating;
    const unlinkLines = async (lineIds: number[]): Promise<void> => {
      if (!lineIds.length) return;
      // fields_relational.py:1056: delete when the inverse cascades, else set it to False (12.13)
      if (cascade) toDelete.push(...lineIds);
      else await write(coEnv, co.name, lineIds, { [inverse]: false });
    };
    const flush = async (): Promise<void> => {
      if (toDelete.length) { await unlink(coEnv, co.name, [...toDelete]); toDelete.length = 0; }
      if (toCreate.length) {
        const created = await create(coEnv, co.name, toCreate.splice(0));
        await checkDomain(created);
      }
      for (const [rid, lineIds] of toLink) {
        const current = new Set(await coModel.search(D.cond(inverse, "=", rid), { activeTest: false }));
        const lines = lineIds.filter((l) => !current.has(l));
        await checkDomain(lines);
        if (lines.length) await write(coEnv, co.name, lines, { [inverse]: rid });
      }
      toLink.clear();
    };
    for (const cmd of commands) {
      switch (cmd.op) {
        case "create":
          for (const rid of ids) toCreate.push({ ...cmd.values, [inverse]: rid });
          allowFullDelete = false;
          break;
        case "update": await write(coEnv, co.name, [cmd.id], cmd.values); break;
        case "delete": toDelete.push(cmd.id); break;
        case "unlink": await unlinkLines([cmd.id]); break;
        case "link": {
          const last = ids[ids.length - 1]!;
          toLink.set(last, [...(toLink.get(last) ?? []), cmd.id]);
          allowFullDelete = false;
          break;
        }
        case "clear": case "set": {
          const lineIds = cmd.op === "set" ? [...cmd.ids] : [];
          if (!allowFullDelete) {
            if (lineIds.length) { const last = ids[ids.length - 1]!; toLink.set(last, [...(toLink.get(last) ?? []), ...lineIds]); }
            continue;
          }
          await flush();
          // fields_relational.py:1090: lines of the records not in line_ids are unlinked, searched as the user (12.19)
          const others = await coModel.search(D.and([domain, D.cond(inverse, "in", [...ids]), D.cond("id", "not in", lineIds)]));
          await unlinkLines(others);
          await flush();
          if (lineIds.length) {
            await checkDomain(lineIds);
            await write(coEnv, co.name, lineIds, { [inverse]: ids[ids.length - 1] });
          }
          break;
        }
      }
    }
    await flush();
    return;
  }

  // many2many (fields_relational.py:1457-1640)
  if (!field.relationTable || !field.column1 || !field.column2) throw new NotPorted(`m2m table ${def.name}.${field.name}`);
  const rel = ident(field.relationTable), c1 = ident(field.column1), c2 = ident(field.column2);
  const sudoValues = await new ModelImpl(env.sudo(), def).values(ids, field) as Map<number, number[]>;
  const userValues = env.su ? sudoValues : await new ModelImpl(env, def).values(ids, field) as Map<number, number[]>;
  const oldRelation = new Map<number, number[]>(ids.map((id) => [id, [...(sudoValues.get(id) ?? [])]]));
  // links hidden by active_test are kept (fields_relational.py:1484-1492)
  const allLinks = await runSql<{ x: number; y: number }>(env, sql`SELECT ${c1} AS x, ${c2} AS y FROM ${rel} WHERE ${c1} = ANY(${[...ids]}::int[])`);
  const newRelation = new Map<number, number[]>([...oldRelation].map(([k, v]) => [k, [...v]]));
  const inaccessible = new Set<number>();
  if (!env.su) for (const id of ids) for (const y of sudoValues.get(id) ?? []) if (!(userValues.get(id) ?? []).includes(y)) inaccessible.add(y);
  const added: number[] = [];
  const addRel = (xs: readonly number[], y: number): void => { added.push(y); for (const x of xs) { const l = newRelation.get(x)!; if (!l.includes(y)) l.push(y); } };
  const removeRel = (xs: readonly number[], y: number): void => { if (inaccessible.has(y)) return; for (const x of xs) newRelation.set(x, newRelation.get(x)!.filter((v) => v !== y)); };
  const setRel = (xs: readonly number[], ys: readonly number[]): void => {
    added.push(...ys);
    for (const x of xs) newRelation.set(x, [...new Set([...ys, ...newRelation.get(x)!.filter((v) => inaccessible.has(v))])]);
  };
  const toCreate: Record<string, unknown>[] = [];
  const deleted: number[] = [];
  for (const cmd of commands) {
    switch (cmd.op) {
      case "create": toCreate.push(cmd.values); break;
      case "update": await write(comodelEnv(env, field), co.name, [cmd.id], cmd.values); break;
      case "delete": deleted.push(cmd.id); break;
      case "unlink": removeRel(ids, cmd.id); break;
      case "link": addRel(ids, cmd.id); break;
      case "clear": case "set":
        if (toCreate.length) throw new NotPorted(`many2many CREATE before ${cmd.op} in ${def.name}.${field.name}`);
        setRel(ids, cmd.op === "set" ? cmd.ids : []);
        break;
    }
  }
  if (toCreate.length) for (const y of await create(comodelEnv(env, field), co.name, toCreate)) addRel(ids, y);
  if (deleted.length) {
    await unlink(comodelEnv(env, field), co.name, deleted);
    const del = new Set(deleted.filter((y) => !inaccessible.has(y)));
    for (const [x, ys] of oldRelation) oldRelation.set(x, ys.filter((y) => !del.has(y)));
    for (const [x, ys] of newRelation) newRelation.set(x, ys.filter((y) => !del.has(y)));
  }
  // fields_relational.py:1590-1597: read access on added records (the model's ACL when none), and the field's domain
  await checkAddedRead(added);
  await checkDomain([...new Set(added)]);
  const existingPairs = new Set(allLinks.map((r) => `${r.x}/${r.y}`));
  // :1597-1605 the cache of the written records (unchanged when the relation is the same)
  const changed = [...newRelation].some(([x, ys]) => { const o = oldRelation.get(x) ?? []; return o.length !== ys.length || o.some((y, i) => y !== ys[i]); });
  if (changed) rememberX2manyOrder(env.cr, def.name, field.name, newRelation);
  for (const [x, ys] of newRelation) {
    const old = new Set(oldRelation.get(x) ?? []);
    const add = ys.filter((y) => !old.has(y) && !existingPairs.has(`${x}/${y}`));
    const remove = [...old].filter((y) => !ys.includes(y));
    for (const y of add) await runSql(env, sql`INSERT INTO ${rel} (${c1}, ${c2}) VALUES (${x}, ${y}) ON CONFLICT DO NOTHING`);
    if (remove.length) await runSql(env, sql`DELETE FROM ${rel} WHERE ${c1} = ${x} AND ${c2} = ANY(${remove}::int[])`);
  }
}

/** Compare helper for overrides: Python `!=` on cache values. */
export function differs(a: unknown, b: unknown): boolean {
  return !cacheEqual(a, b);
}

/**
 * fields_numeric.py:271-289 Monetary.convert_to_cache(value, records): `float(value or 0.0)` rounded with the
 * currency of the written records (read as superuser); several different currencies raise ValueError.
 */
async function monetaryToCache(env: Environment, def: ModelDef, ids: readonly number[], field: FieldDef, value: unknown): Promise<number> {
  const raw = plainNumber(value);
  const n = raw === false || raw === null || raw === undefined ? 0 : typeof raw === "number" ? raw : Number.NaN;
  if (Number.isNaN(n)) throw new NotPorted(`float(${JSON.stringify(value)}) for ${def.name}.${field.name}`);
  if (n === 0) return 0;
  // fields_numeric.py:227 get_currency_field
  const cf = field.currencyField ?? (def.fields.has("currency_id") ? "currency_id" : def.fields.has("x_currency_id") ? "x_currency_id" : null);
  if (cf === null) throw new NotPorted(`monetary field ${def.name}.${field.name} without currency field`);
  const cur = await new ModelImpl(env.sudo(), def).values(ids, def.fields.get(cf)!);
  const currencies = [...new Set([...cur.values()].filter((c): c is number => typeof c === "number"))];
  if (currencies.length > 1) throw new OdooValueError(`Got multiple currencies while assigning values of monetary field ${def.name}.${field.name}`);
  if (!currencies.length) return n;
  const row = (await env.cr.query<{ rounding: string | number }>("SELECT rounding FROM res_currency WHERE id = $1", [currencies[0]])).rows[0];
  return row ? roundMonetary(n, Number(row.rounding)) : n;
}
