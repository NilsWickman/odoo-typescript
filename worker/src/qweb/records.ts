/**
 * Records and `env` for the Python expressions of server templates: the attribute protocol of `src/pyexpr`
 * (`PyObject`) over the ORM of this port. Field reads go through `DbRec`; other methods must be registered with
 * `registerPyMethod` (the Python method of the model, ported), an unregistered name refuses with NotPorted.
 */
import { NotPorted } from "../errors";
import { userHasGroup } from "../web/groups";
import { DbRec, type NewRec } from "../orm/recompute";
import type { Environment, FieldDef } from "../orm/types";
import { keyed } from "../orm/keys";
import { ModelImpl } from "../orm/model";
import { hasFieldAccess } from "../orm/sql";
import { asFloat, isDict, isPyFloat, Markup, PyKwargs, PyObject, pyBool, toNumber, dictEntries } from "../pyexpr/values";

export type PyMethod = (recs: PyRecords, args: unknown[], kwargs: ReadonlyMap<string, unknown>) => unknown;

const METHODS = new Map<string, Map<string, PyMethod>>();

/** A method of `model` as templates call it (`record.name(...)`). */
/** A method registered for templates and code on this model (registerPyMethod). */
export function hasPyMethod(model: string, name: string): boolean {
  return METHODS.get(model)?.has(name) ?? false;
}

export function registerPyMethod(model: string, name: string, fn: PyMethod): void {
  const m = METHODS.get(model) ?? new Map<string, PyMethod>();
  m.set(name, keyed("pyMethod", model, name, fn));
  METHODS.set(model, m);
}

/** The positional arguments and keyword arguments of a call. */
function splitArgs(raw: unknown[]): [unknown[], ReadonlyMap<string, unknown>] {
  const last = raw[raw.length - 1];
  if (last instanceof PyKwargs) return [raw.slice(0, -1), last.entries];
  return [raw, new Map()];
}

/**
 * Rendering as the user (mail.render.mixin with a non-sudo template, src/mail/template_send.ts `asRenderer`): a field
 * read on a record goes through `fetch` (models.py:3098-3160), which checks the field's groups, the model's access and
 * the record rules, and raises AccessError when one fails. Odoo skips the checks for a value already in its cache (read
 * earlier, even in sudo), which this port does not follow; so a failing check refuses instead of raising. The per-request
 * cache key counts the renders in progress that need the checks.
 */
export const RENDER_AS_USER = "qweb.renderAsUser";

async function checkRenderRead(env: Environment, def: ReturnType<Environment["reg"]["model"]>, field: FieldDef, id: number): Promise<void> {
  if (env.su || !((env.cache.get(RENDER_AS_USER) as number | undefined) ?? 0)) return;
  const key = `${RENDER_AS_USER}:${env.uid}:${def.name}:${id}:${field.name}`;
  if (env.cache.has(key)) return;
  if (!(await hasFieldAccess(env, field))) throw new NotPorted(`mail template rendered as a user without access to ${def.name}.${field.name}`);
  try {
    await new ModelImpl(env, def).checkAccess([id], "read");
  } catch (e) {
    if (e instanceof NotPorted) throw e;
    throw new NotPorted(`mail template rendered as a user without read access to ${def.name}(${id})`);
  }
  env.cache.set(key, true);
}

export class PyRecords extends PyObject {
  constructor(readonly env: Environment, readonly model: string, readonly ids: readonly number[]) {
    super();
  }

  get def(): ReturnType<Environment["reg"]["model"]> {
    return this.env.reg.model(this.model);
  }

  /** The same records under another environment (sudo, with_user, with_context): a subclass keeps its own class. */
  protected with(env: Environment): PyRecords {
    return new PyRecords(env, this.model, this.ids);
  }

  browse(ids: readonly number[]): PyRecords {
    return new PyRecords(this.env, this.model, ids);
  }

  ensureOne(): number {
    if (this.ids.length !== 1) throw new Error(`ValueError: Expected singleton: ${this.pyToString()}`);
    return this.ids[0]!;
  }

  /** `record[name]` of one record, as the Python value. */
  async field(name: string): Promise<unknown> {
    const def = this.def;
    const field = def.fields.get(name);
    if (field === undefined) throw new NotPorted(`${this.model} has no field ${name}`);
    if (this.ids.length === 0) return emptyOf(this.env, field);
    if (this.ids.length > 1) {
      // fields_relational.py:41-71 `_Relational.__get__` of several records: `convert_to_record_multi`, the union of
      // their values in order without duplicates (Many2one :357-361, _RelationalMulti :727-731)
      if (field.type === "many2one" || field.type === "one2many" || field.type === "many2many") {
        const ids: number[] = [];
        for (const id of this.ids) {
          const v = await this.browse([id]).field(name);
          if (v instanceof PyRecords) for (const i of v.ids) if (!ids.includes(i)) ids.push(i);
        }
        return new PyRecords(this.env, field.relation!, ids);
      }
      throw new Error(`ValueError: Expected singleton: ${this.pyToString()}`);
    }
    await checkRenderRead(this.env, def, field, this.ids[0]!);
    return toPython(this.env, field, await new DbRec(this.env, def, this.ids[0]!).get(name));
  }

  pyGetAttr(name: string): unknown {
    switch (name) {
      case "id": return this.ids.length === 0 ? false : this.ensureOne();
      case "ids": return [...this.ids];
      case "env": return new PyEnv(this.env);
      case "_name": return this.model;
      case "_fields": return new Map([...this.def.fields.entries()].map(([k, f]) => [k, new PyField(f)]));
      case "sudo": return () => this.with(this.env.sudo());
      case "with_user": return (user: unknown) => {
        const uid = user instanceof PyRecords ? user.ensureOne() : Number(user);
        return this.with(this.env.withUser(uid));
      };
      case "ensure_one": return () => { this.ensureOne(); return this; };
      // models.py browse(ids=None): nothing for a falsy value, one record for an int, else the ids in order (lunch's
      // supplier mail template: `user.env['res.currency'].browse(order.get('currency_id'))`)
      case "browse": return (ids: unknown = null) => {
        if (!pyBool(ids)) return this.browse([]);
        if (typeof ids === "number" && Number.isInteger(ids)) return this.browse([ids]);
        if (Array.isArray(ids) && ids.every((x) => typeof x === "number" && Number.isInteger(x))) return this.browse(ids as number[]);
        throw new NotPorted(`${this.model}.browse(${typeof ids}) in a template`);
      };
      case "exists": return async () => {
        const rows = (await this.env.cr.query<{ id: number }>(`SELECT id FROM "${this.def.table}" WHERE id = ANY($1::int[])`, [[...this.ids]])).rows;
        const found = new Set(rows.map((r) => r.id));
        return this.browse(this.ids.filter((i) => found.has(i)));
      };
      case "with_context": return (...raw: unknown[]) => {
        const [args, kwargs] = splitArgs(raw);
        const ctx: Record<string, unknown> = args.length && isDict(args[0]) ? Object.fromEntries(dictEntries(args[0]).map(([k, v]) => [String(k), v])) : { ...this.env.context };
        for (const [k, v] of kwargs) ctx[k] = v;
        return this.with(this.env.withContext(ctx));
      };
      case "filtered": return async (fn: unknown) => {
        const out: number[] = [];
        for (const id of this.ids) {
          const one = this.browse([id]);
          const r = typeof fn === "function" ? await (fn as (r: PyRecords) => unknown)(one) : await one.path(String(fn));
          if (pyBool(r)) out.push(id);
        }
        return this.browse(out);
      };
      // models.py:5735-5763 sorted(key=None|str|fn, reverse=False): fewer than two records are returned as is; a single
      // field name with non-empty, comparable values sorts on them (stable, as Python's sorted)
      case "sorted": return async (...raw: unknown[]) => {
        const [args, kwargs] = splitArgs(raw);
        if (this.ids.length < 2) return this;
        const key = args[0] ?? kwargs.get("key");
        const reverse = pyBool(args[1] ?? kwargs.get("reverse") ?? false);
        if (typeof key !== "string" || !/^\w+$/.test(key) || !this.def.fields.has(key)) throw new NotPorted(`${this.model}.sorted(${String(key)}) in a template`);
        const keyed: { id: number; v: unknown }[] = [];
        for (const id of this.ids) keyed.push({ id, v: await this.browse([id]).field(key) });
        if (keyed.some((k) => k.v === false || k.v === null || (typeof k.v !== "string" && typeof k.v !== "number"))) throw new NotPorted(`${this.model}.sorted(${key}) over empty or non-scalar values`);
        const cmp = (a: unknown, b: unknown): number => (a! < b! ? -1 : a! > b! ? 1 : 0);
        const sorted = [...keyed].sort((a, b) => cmp(a.v, b.v));
        if (reverse) { // sorted(reverse=True) keeps equal keys in their original order
          const desc = [...keyed].sort((a, b) => cmp(b.v, a.v));
          return this.browse(desc.map((k) => k.id));
        }
        return this.browse(sorted.map((k) => k.id));
      };
      case "mapped": return async (fn: unknown) => {
        const out: unknown[] = [];
        for (const id of this.ids) {
          const one = this.browse([id]);
          const r = typeof fn === "function" ? await (fn as (r: PyRecords) => unknown)(one) : await one.path(String(fn));
          if (r instanceof PyRecords) out.push(...r.ids.map((i) => r.browse([i])));
          else out.push(r);
        }
        if (out.length && out.every((x) => x instanceof PyRecords)) {
          const first = out[0] as PyRecords;
          return first.browse([...new Set(out.flatMap((x) => [...(x as PyRecords).ids]))]);
        }
        return out;
      };
      default:
    }
    const method = METHODS.get(this.model)?.get(name);
    if (method !== undefined) return (...raw: unknown[]) => { const [args, kwargs] = splitArgs(raw); return method(this, args, kwargs); };
    if (this.def.fields.has(name)) return this.field(name);
    throw new NotPorted(`${this.model}.${name} in a template (register it with registerPyMethod)`);
  }

  /** `record.mapped('a.b')` of one record. */
  async path(path: string): Promise<unknown> {
    let cur: unknown = this;
    for (const part of path.split(".")) {
      if (!(cur instanceof PyRecords)) throw new NotPorted(`path ${path} through a non record`);
      cur = await cur.field(part);
    }
    return cur;
  }

  override pyTruth(): boolean { return this.ids.length > 0; }
  override pyLen(): number { return this.ids.length; }
  override pyIter(): unknown[] { return this.ids.map((id) => this.browse([id])); }
  override pyEquals(other: unknown): boolean {
    return other instanceof PyRecords && other.model === this.model && other.ids.length === this.ids.length && other.ids.every((id, i) => id === this.ids[i]);
  }
  override pyContains(item: unknown): boolean {
    if (typeof item === "string") return this.def.fields.has(item); // BaseModel.__contains__ on a field name
    return item instanceof PyRecords && item.ids.length === 1 && this.ids.includes(item.ids[0]!);
  }
  override pyGetItem(key: unknown): unknown {
    if (typeof key === "string") return this.field(key);
    if (typeof key === "number") return this.browse([this.ids[key < 0 ? this.ids.length + key : key]!]);
    throw new NotPorted(`${this.model}[${String(key)}]`);
  }
  // models.py `__getitem__` with a slice: the records of the sliced ids
  override pyFromSlice(items: unknown[]): unknown { return this.browse(items.flatMap((r) => (r as PyRecords).ids)); }
  override pyAdd(other: unknown): unknown {
    if (!(other instanceof PyRecords)) throw new TypeError("can only concatenate records");
    return this.browse([...this.ids, ...other.ids]);
  }
  override pyToString(): string { return `${this.model}(${this.ids.join(",")}${this.ids.length === 1 ? "," : ""})`; }
}

/**
 * A new record as Python code sees it: `id` is a NewId, whose `str()` is `NewId_0x<address>` (models.py NewId.__repr__
 * with a null origin); the address of the Python object is not reproducible, one fixed value stands for it.
 */
export class PyNewRecord extends PyObject {
  constructor(readonly rec: NewRec) {
    super();
  }
  get def(): NewRec["def"] { return this.rec.def; }
  get model(): string { return this.rec.def.name; }
  get ids(): readonly unknown[] { return ["NewId_0x1"]; }
  async field(name: string): Promise<unknown> {
    const field = this.rec.def.fields.get(name);
    if (field === undefined) throw new NotPorted(`${this.rec.def.name}.${name} of a new record in a template`);
    return toPython(this.rec.env, field, await this.rec.get(name));
  }
  pyGetAttr(name: string): unknown {
    switch (name) {
      case "id": return "NewId_0x1";
      case "_name": return this.rec.def.name;
      case "env": return new PyEnv(this.rec.env);
      case "sudo": return () => this;
      case "ensure_one": return () => this;
      default:
    }
    return this.field(name);
  }
  override pyTruth(): boolean { return true; }
  override pyLen(): number { return 1; }
  override pyIter(): unknown[] { return [this]; }
}

/** The value of an empty recordset (fields.py `__get__` on no record: `convert_to_record(None)`). */
function emptyOf(env: Environment, field: FieldDef): unknown {
  switch (field.type) {
    case "many2one": case "one2many": case "many2many": return new PyRecords(env, field.relation!, []);
    case "float": case "monetary": return asFloat(0);
    case "integer": return 0;
    default: return false;
  }
}

/** The cache value of `DbRec.get` as `convert_to_record` gives it to Python code. */
export function toPython(env: Environment, field: FieldDef, v: unknown): unknown {
  switch (field.type) {
    case "many2one": return new PyRecords(env, field.relation!, typeof v === "number" && v ? [v] : []);
    case "one2many": case "many2many": return new PyRecords(env, field.relation!, Array.isArray(v) ? (v as number[]) : []);
    case "float": case "monetary": return asFloat(isPyFloat(v) ? v.float : v === null || v === undefined || v === false ? 0 : toNumber(v));
    case "integer": return v === null || v === undefined || v === false ? 0 : v;
    case "boolean": return Boolean(v);
    case "html": return v === null || v === undefined || v === false ? false : new Markup(String(v));
    default: return v === null || v === undefined ? false : v;
  }
}

/** `self.env` in a template. */
/**
 * A field of `records._fields` in an expression: `_description_selection(env)` (fields_selection.py:202-212, the
 * selection's (value, label) pairs, the labels in the environment's language); its other attributes refuse.
 */
export class PyField extends PyObject {
  constructor(readonly def: FieldDef) {
    super();
  }
  pyGetAttr(name: string): unknown {
    switch (name) {
      case "_description_selection": return (env: unknown) => {
        if (!(env instanceof PyEnv)) throw new NotPorted(`_description_selection of ${this.def.name} without an environment`);
        if (this.def.selection === null) throw new NotPorted(`_description_selection of the callable selection of ${this.def.name}`);
        const lang = env.env.lang ?? "en_US";
        return this.def.selection.map((o) => [o.value, o.labels[lang] ?? o.label]);
      };
      case "name": return this.def.name;
      case "type": return this.def.type;
      default: throw new NotPorted(`attribute ${name} of a field in an expression`);
    }
  }
  override pyToString(): string { return `<field ${this.def.name}>`; }
}

export class PyEnv extends PyObject {
  constructor(readonly env: Environment) {
    super();
  }
  pyGetAttr(name: string): unknown {
    switch (name) {
      case "context": return new Map(Object.entries(this.env.context));
      case "lang": return this.env.lang ?? null;
      case "uid": return this.env.uid;
      case "user": return new PyRecords(this.env, "res.users", [this.env.uid]);
      case "company": return (async () => new PyRecords(this.env, "res.company", [await this.env.company()]))();
      case "companies": return (async () => new PyRecords(this.env, "res.company", await this.env.companies()))();
      // environments.py:187-190 `is_system()`: superuser mode, or the user has group "Settings" (res_users.py:1288-1290)
      case "is_system": return async () => this.env.su || userHasGroup(this.env.sudo(), "base.group_system");
      // environments.py `ref(xml_id, raise_if_not_found=True)`: ir.model.data._xmlid_to_res_model_res_id
      case "ref": return async (xmlid: unknown, raiseIfNotFound: unknown = true) => {
        const [module, name] = String(xmlid).split(".", 2);
        const row = (await this.env.cr.query<{ model: string; res_id: number }>(
          "SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name])).rows[0];
        if (!row) {
          if (raiseIfNotFound) throw new NotPorted(`env.ref of a missing xmlid ${String(xmlid)} (ValueError)`);
          return null;
        }
        return new PyRecords(this.env, row.model, [row.res_id]);
      };
      default: throw new NotPorted(`env.${name} in a template`);
    }
  }
  override pyGetItem(key: unknown): unknown {
    return new PyRecords(this.env, String(key), []);
  }
  override pyContains(item: unknown): boolean { return this.env.reg.models.has(String(item)); }
}

