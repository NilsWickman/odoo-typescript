/**
 * `onchange` (odoo/addons/web/models/models.py:2189-2395) with its `RecordSnapshot` (:2460-2560): defaults on the
 * first call, a new record (`new(values, origin=self)`) on which the changed values are assigned, the
 * `@api.onchange` methods (registered per model, src/orm/recompute.ts registerOnchange) applied until no field of
 * the specification changes any more, and the difference of the two snapshots in `web_read` format.
 */
import { NotPorted, OdooError } from "../errors";
import { sanitizeHtml } from "../orm/write_values";
import { checkModelAccess } from "../orm/access";
import { hasFieldAccess } from "../orm/sql";
import { parseCommands } from "../orm/commands";
import { cacheEqual, convertToCache } from "../orm/convert";
import { coComputed } from "../orm/create";
import { displayNamesOrFalse, ModelImpl } from "../orm/model";
import { DbRec, DELEGATE_PARENT_MODELS, fieldDefault, hasResolvedDefault, localDependents, NewRec, type Rec } from "../orm/recompute";
import { onchangeSteps, refuseUnportedOnchangeOverride } from "../orm/onchange_methods";
import type { BinaryValue, Context, Environment, FieldDef, ModelDef, RecordValues } from "../orm/types";
import { binaryBytes, floatToRead, integerToRead } from "../orm/values";
import { envFor, isRecord, parseSpecification, recordIds, type FieldSpec, type Specification } from "./common";
import { defaultGet } from "./defaults";
import { hasGeneratedDefault } from "../orm/defaults_gen";
import { webRead } from "./read";
import { registerBaseMethod } from "./register";

const X2MANY = new Set(["one2many", "many2many"]);

function withSubContext(env: Environment, ctx: Context | undefined): Environment {
  return ctx === undefined ? env : env.withContext({ ...env.context, ...ctx });
}

/** x2many commands applied on a list of ids (the cache of a new record, fields_relational.py:625). */
export function applyCommands(current: readonly number[], value: unknown, field: string): number[] {
  const ids = [...current];
  for (const cmd of parseCommands(value, field)) {
    switch (cmd.op) {
      case "link": if (!ids.includes(cmd.id)) ids.push(cmd.id); break;
      case "unlink": case "delete": { const i = ids.indexOf(cmd.id); if (i >= 0) ids.splice(i, 1); break; }
      case "clear": ids.length = 0; break;
      case "set": ids.length = 0; for (const id of cmd.ids) if (!ids.includes(id)) ids.push(id); break;
      case "update": if (!ids.includes(cmd.id)) ids.push(cmd.id); if (Object.keys(cmd.values).length) throw new NotPorted(`onchange x2many UPDATE values in ${field}`); break;
      case "create": throw new NotPorted(`onchange with new x2many lines in ${field}`);
    }
  }
  return ids;
}

/**
 * x2many commands on the lines of a new record (fields_relational.py:1160-1185 write_batch on new records): CREATE
 * makes a new line (`comodel.new(values, ref=...)`) whose inverse is the record, UPDATE puts values on a new copy
 * of an existing line, LINK/SET/UNLINK/DELETE/CLEAR change the list.
 */
async function linesFromCommands(rec: NewRec, field: FieldDef, current: readonly (number | NewRec)[], value: unknown, where: string): Promise<(number | NewRec)[]> {
  const lines = [...current];
  const co = rec.env.reg.model(field.relation!);
  const parsed = parseCommands(value, where);
  if (!rec.env.su) {
    const refIds = new Set<number>();
    for (const cmd of parsed) {
      if ((cmd.op === "update" || cmd.op === "link") && cmd.id > 0) refIds.add(cmd.id);
      else if (cmd.op === "set") for (const id of cmd.ids) if (id > 0) refIds.add(id);
    }
    if (refIds.size) await rec.env.model(co.name).checkAccess([...refIds], "read");
  }
  const key = (l: number | NewRec): number | NewRec => (l instanceof NewRec && l.origin !== null ? l.origin : l);
  const indexOf = (id: number): number => lines.findIndex((l) => key(l) === id);
  for (const cmd of parsed) {
    switch (cmd.op) {
      case "create": {
        const line = new NewRec(rec.env, co, null);
        line.ref = cmd.ref;
        // a line of a default value (no client reference): its fields take their defaults (models.py default_get)
        if (!cmd.ref) {
          line.defaultOf = async (name) => {
            const defaults = await defaultGet(rec.env, co.name, [name]);
            return name in defaults ? clientToCache(line, co.fields.get(name)!, defaults[name]) : undefined;
          };
        }
        if (field.type === "one2many" && field.relationField) line.put(field.relationField, rec);
        for (const [k, v] of Object.entries(cmd.values)) {
          const f = co.fields.get(k);
          if (f && k !== "id") line.put(k, await clientToCache(line, f, v));
        }
        lines.push(line);
        break;
      }
      case "update": {
        const line = new NewRec(rec.env, co, cmd.id);
        for (const [k, v] of Object.entries(cmd.values)) {
          const f = co.fields.get(k);
          if (f && k !== "id") line.put(k, await clientToCache(line, f, v));
        }
        const i = indexOf(cmd.id);
        if (i >= 0) lines[i] = line; else lines.push(line);
        break;
      }
      case "link": if (indexOf(cmd.id) < 0) lines.push(cmd.id); break;
      case "unlink": case "delete": { const i = indexOf(cmd.id); if (i >= 0) lines.splice(i, 1); break; }
      case "clear": lines.length = 0; break;
      case "set": lines.length = 0; for (const id of cmd.ids) if (indexOf(id) < 0) lines.push(id); break;
    }
  }
  return lines;
}

/** `convert_to_cache(value, validate=False)` of a client value for a new record. */
async function clientToCache(rec: NewRec, field: FieldDef, value: unknown): Promise<unknown> {
  const where = `${rec.def.name}.${field.name}`;
  if (X2MANY.has(field.type)) {
    const current = rec.values.has(field.name) ? (rec.values.get(field.name) as (number | NewRec)[]) : [];
    return linesFromCommands(rec, field, current, value, where);
  }
  if (field.type === "binary" || field.type === "image") {
    if (!value) return null;
    if (isRecord(value) && typeof value["content"] === "string") {
      // fields_binary.py:96-105: a dict with base64 content and filename
      return binaryBytes(new Uint8Array(Buffer.from(value["content"], "base64")), typeof value["filename"] === "string" ? value["filename"] : "");
    }
    // a string from RPC is base64 encoded (fields_binary.py:89-92)
    if (typeof value === "string") return binaryBytes(new Uint8Array(Buffer.from(value, "base64")));
    throw new NotPorted(`onchange binary value for ${where}`);
  }
  if (field.type === "properties") {
    if (!value || (Array.isArray(value) && value.length === 0)) return [];
    throw new NotPorted(`onchange properties value for ${where}`);
  }
  if (field.type === "html") {
    // validate=False: the sanitizer does not run on onchange values
    return value === false || value === null || value === undefined ? null : String(value);
  }
  if (field.type === "selection") return value === false || value === null || value === undefined ? null : String(value);
  if (field.type === "many2one" && isRecord(value) && Object.keys(value).some((k) => k !== "id")) {
    // fields_relational.py:342-343: a dict is a new record of the comodel (the unsaved parent of a line)
    const co = rec.env.reg.model(field.relation!);
    const originId = typeof value["id"] === "number" ? value["id"] : null;
    if (!rec.env.su && originId !== null && originId > 0) {
      await rec.env.model(co.name).checkAccess([originId], "read");
    }
    const parent = new NewRec(rec.env, co, originId);
    for (const [k, v] of Object.entries(value)) {
      const f = co.fields.get(k);
      if (f && k !== "id") parent.put(k, await clientToCache(parent, f, v));
    }
    if (parent.origin === null) {
      parent.defaultOf = async (name) => {
        const defaults = await defaultGet(rec.env, co.name, [name]);
        return name in defaults ? clientToCache(parent, co.fields.get(name)!, defaults[name]) : undefined;
      };
    }
    return parent;
  }
  const cached = convertToCache(field, value, rec.def.name);
  if (!rec.env.su && field.type === "many2one" && typeof cached === "number" && cached > 0 && field.relation) {
    await rec.env.model(field.relation).checkAccess([cached], "read");
  }
  return cached;
}

// ------------------------------------------------------------------------------------------------- snapshots

/** A line of an x2many snapshot: its database id (also for a modified copy), or the new line itself. */
type LineKey = number | NewRec;
function lineKey(line: Rec): LineKey {
  if (line.id !== null) return line.id;
  if (line instanceof NewRec) return line.origin ?? line;
  throw new TypeError("x2many line without id");
}
interface X2manySnap { readonly ids: LineKey[]; readonly lines: Map<LineKey, Snapshot> }
type SnapValue = unknown;

/** models.py:2460 RecordSnapshot. */
class Snapshot {
  readonly values = new Map<string, SnapValue>();
  constructor(readonly rec: Rec, readonly spec: Specification) {}

  static async of(rec: Rec, spec: Specification, fetch = true): Promise<Snapshot> {
    const s = new Snapshot(rec, spec);
    if (fetch) for (const name of Object.keys(spec)) await s.fetch(name);
    return s;
  }

  async fetch(name: string): Promise<void> {
    const field = this.rec.def.fields.get(name);
    // `record[name]` of a name that is no field: KeyError(name) (round 11; it refused before)
    if (!field) throw new OdooError("builtins.KeyError", name);
    if (!this.rec.env.su && !(await hasFieldAccess(this.rec.env, field))) return;
    if (X2MANY.has(field.type)) {
      const lines = await this.rec.rels(name);
      const sub = this.spec[name]?.fields ?? {};
      const ctx = this.spec[name]?.context;
      const map = new Map<LineKey, Snapshot>();
      for (const line of lines) {
        const l = ctx && line.id !== null ? new DbRec(withSubContext(line.env, ctx), line.def, line.id) : line;
        map.set(lineKey(line), await Snapshot.of(l, sub));
      }
      this.values.set(name, { ids: lines.map(lineKey), lines: map } satisfies X2manySnap);
    } else {
      this.values.set(name, await this.rec.get(name));
    }
  }

  async hasChanged(name: string): Promise<boolean> {
    const field = this.rec.def.fields.get(name)!;
    if (!this.rec.env.su && !(await hasFieldAccess(this.rec.env, field))) return false;
    if (!this.values.has(name)) return true;
    if (!X2MANY.has(field.type)) return !sameValue(field, this.values.get(name), await this.rec.get(name));
    const snap = this.values.get(name) as X2manySnap;
    const lines = await this.rec.rels(name);
    const now = lines.map(lineKey);
    if (snap.ids.length !== now.length || snap.ids.some((id) => !now.includes(id))) return true;
    // a stored line an onchange method replaced by its edited copy
    if (lines.some((l, i) => isEdit(l) && !(snap.lines.get(now[i]!)?.rec instanceof NewRec))) return true;
    for (const line of snap.lines.values()) for (const sub of Object.keys(this.spec[name]?.fields ?? {})) if (await line.hasChanged(sub)) return true;
    return false;
  }

  /** models.py:2503 diff(other, force). */
  async diff(other: Snapshot | null, force: boolean): Promise<RecordValues> {
    const simple: Record<string, FieldSpec> = {};
    const x2many: [string, FieldSpec][] = [];
    for (const [name, fspec] of Object.entries(this.spec)) {
      if (name === "id") continue;
      const field = this.rec.def.fields.get(name)!;
      if (!this.rec.env.su && !(await hasFieldAccess(this.rec.env, field))) continue;
      if (!force && other && other.values.has(name) && snapEqual(field, other.values.get(name), this.values.get(name))) continue;
      if (X2MANY.has(field.type)) x2many.push([name, fspec]);
      else simple[name] = fspec;
    }
    const result = await webReadRec(this.rec, simple, (n) => this.values.get(n));
    for (const [name, fspec] of x2many) {
      const field = this.rec.def.fields.get(name)!;
      const mine = this.values.get(name) as X2manySnap;
      const theirs: X2manySnap = force || !other ? { ids: [], lines: new Map() } : (other.values.get(name) as X2manySnap | undefined) ?? { ids: [], lines: new Map() };
      const commands: unknown[] = [];
      // web/models/models.py:2538: Command.delete / Command.unlink are (2|3, id, 0)
      for (const id of theirs.ids) if (!mine.ids.includes(id)) commands.push([field.type === "one2many" ? 2 : 3, typeof id === "number" ? id : (id.ref ?? 0), 0]);
      for (const id of mine.ids) {
        const line = mine.lines.get(id)!;
        if (!force && theirs.ids.includes(id)) {
          const d = await line.diff(theirs.lines.get(id)!, false);
          if (Object.keys(d).length) commands.push([1, typeof id === "number" ? id : (id.ref ?? 0), d]);
        } else if (typeof id !== "number") {
          // a new line: (CREATE, ref or 0, its values) (models.py:2541-2544)
          commands.push([0, id.ref ?? 0, await line.diff(null, true)]);
        } else if (line.rec instanceof NewRec) {
          // an existing line modified in the form: LINK with the database values, then UPDATE with the differences
          const base = await Snapshot.of(new DbRec(line.rec.env, line.rec.def, id), line.spec);
          const [data] = await webRead(withSubContext(this.rec.env, fspec.context), field.relation!, [id], fspec.fields ?? {});
          commands.push([4, id, data ?? { id }]);
          const d = await line.diff(base, false);
          if (Object.keys(d).length) commands.push([1, id, d]);
        } else {
          // an existing line: LINK with its data, then its differences (models.py:2547-2556)
          const comodel = field.relation!;
          const [base] = await webRead(withSubContext(this.rec.env, fspec.context), comodel, [id], fspec.fields ?? {});
          commands.push([4, id, base ?? { id }]);
        }
      }
      if (commands.length) result[name] = commands;
    }
    return result;
  }
}

/** Fields other than booleans have one empty value in the cache (`convert_to_cache`): a compute's False is the client's empty value. */
function sameValue(field: FieldDef, a: SnapValue, b: SnapValue): boolean {
  if (field.type === "boolean") return cacheEqual(a, b);
  // fields_numeric.py convert_to_cache: False/None of an Integer/Float/Monetary is 0 in the cache, so a compute that
  // assigns False and one that assigns 0.0 leave the same value (no onchange diff)
  if (field.type === "integer" || field.type === "float" || field.type === "monetary") {
    const num = (v: SnapValue): SnapValue => (v === false || v === null || v === undefined ? 0 : v);
    return cacheEqual(num(a), num(b));
  }
  const empty = (v: SnapValue): SnapValue => (v === false || v === undefined ? null : v);
  return cacheEqual(empty(a), empty(b));
}

function snapEqual(field: FieldDef, a: SnapValue, b: SnapValue): boolean {
  if (!X2MANY.has(field.type)) return sameValue(field, a, b);
  const x = a as X2manySnap, y = b as X2manySnap;
  if (!(x.ids.length === y.ids.length && x.ids.every((id, i) => id === y.ids[i])
    && !y.ids.some((id) => isEdit(y.lines.get(id)?.rec) && !(x.lines.get(id)?.rec instanceof NewRec)))) return false;
  // models.py:2476 RecordSnapshot.__eq__: the line snapshots compare by value too (a stored line recomputed because
  // its parent changed, e.g. sale.order.line.margin after the order's company)
  for (const id of y.ids) {
    const xl = x.lines.get(id), yl = y.lines.get(id);
    if (!xl || !yl) return false;
    for (const [name, v] of yl.values) {
      const f = yl.rec.def.fields.get(name)!;
      if (!xl.values.has(name) || !lineValueEqual(f, xl.values.get(name), v)) return false;
    }
  }
  return true;
}

/** A line's value in two snapshots: binaries compare by checksum and size (two reads of one attachment are two objects). */
function lineValueEqual(field: FieldDef, a: SnapValue, b: SnapValue): boolean {
  if ((field.type === "binary" || field.type === "image") && isRecord(a) && isRecord(b) && "checksum" in a && "checksum" in b) {
    return a["checksum"] === b["checksum"] && a["size"] === b["size"];
  }
  return snapEqual(field, a, b);
}

/** A line the form or an onchange method edited (a new record), not a stored line copied for its parent's change. */
function isEdit(line: unknown): boolean {
  return line instanceof NewRec && !line.cascaded;
}

/** `web_read` on a (new) record, from snapshot values (models.py:315 web_read, :3014 _read_format load='web'). */
async function webReadRec(rec: Rec, spec: Record<string, FieldSpec>, valueOf: (name: string) => unknown): Promise<RecordValues> {
  if (rec.id !== null) {
    const [row] = await webRead(rec.env, rec.def.name, [rec.id], spec);
    const out = { ...(row ?? {}) };
    delete out["id"];
    return out;
  }
  const out: RecordValues = {};
  for (const [name, fspec] of Object.entries(spec)) {
    const field = rec.def.fields.get(name)!;
    if (!rec.env.su && !(await hasFieldAccess(rec.env, field))) continue;
    const v = valueOf(name);
    out[name] = await formatValue(rec.env, field, v, fspec, name);
  }
  return out;
}

async function formatValue(env: Environment, field: FieldDef, v: unknown, fspec: FieldSpec, name: string): Promise<unknown> {
  switch (field.type) {
    case "many2one": {
      const id = v instanceof NewRec ? null : typeof v === "number" ? v : null;
      if (v instanceof NewRec && v.origin === null) return false;
      if (v instanceof NewRec) {
        // web/models/models.py:390-417 web_read of a new record with an origin (the unsaved parent of a line): the
        // origin's id; with `fields`, the new record's own web_read (`cleanup`: its id is the origin) and
        // display_name (computed from the form's values)
        if (!("fields" in fspec) || fspec.fields === undefined) return v.origin;
        const { display_name: dn, ...extra } = fspec.fields;
        if (Object.keys(extra).length) throw new NotPorted(`onchange many2one to a new record with an origin, fields ${Object.keys(extra).join(", ")} (${name})`);
        const vals: RecordValues = { id: v.origin };
        if (dn !== undefined) vals["display_name"] = await v.get("display_name");
        return vals;
      }
      if (id === null) return false;
      if (!("fields" in fspec) || fspec.fields === undefined) return id;
      const coEnv = withSubContext(env, fspec.context);
      const { display_name: _dn, ...extra } = fspec.fields;
      const [row] = Object.keys(extra).length ? await webRead(coEnv, field.relation!, [id], extra) : [{ id }];
      const vals: RecordValues = { ...(row ?? { id }) };
      if ("display_name" in fspec.fields) vals["display_name"] = (await displayNamesOrFalse(coEnv, field.relation!, [id])).get(id) ?? false;
      return vals;
    }
    case "binary": case "image": {
      const b = v as BinaryValue | null;
      if (!b) return false;
      const res: RecordValues = {};
      if (b.filename && b.filename !== name) res["filename"] = b.filename;
      // models.py:3049: for NewIds the content is always included
      res["content"] = Buffer.from(await b.content()).toString("base64");
      res["size"] = b.size;
      res["checksum"] = b.checksum;
      return res;
    }
    case "integer": return integerToRead((v as number | null) ?? 0);
    case "float": return floatToRead(v as number | null);
    case "monetary": return floatToRead(v as number | null);
    case "boolean": return v === true;
    case "properties":
      if (v === null || v === undefined || (Array.isArray(v) && !v.length)) return [];
      throw new NotPorted(`onchange read of properties ${name}`);
    case "one2many": case "many2many":
      throw new TypeError("x2many in simple spec");
    default:
      return v === null || v === undefined ? false : v;
  }
}

// ------------------------------------------------------------------------------------------------- onchange

export interface OnchangeResult { value: RecordValues; warning?: { title: string; message: string; type: string } }

export async function onchange(env: Environment, model: string, ids: readonly number[], valuesIn: Record<string, unknown>,
  fieldNamesIn: readonly string[], spec: Specification): Promise<OnchangeResult | Record<string, never>> {
  const def = env.reg.model(model);
  if (ids.length > 1) throw new NotPorted("onchange on several records");
  // models.py:2240 check_access('write' if self else 'create')
  if (!env.su) {
    await checkModelAccess(env, def, ids.length ? "write" : "create");
    if (ids.length) {
      await new ModelImpl(env, def).checkAccess(ids, "write");
      await new ModelImpl(env, def).checkAccess(ids, "read");
    }
  }
  if (fieldNamesIn.some((f) => !def.fields.has(f))) return {};
  const firstCall = fieldNamesIn.length === 0;
  const values: Record<string, unknown> = { ...valuesIn };
  let fieldNames = [...fieldNamesIn];
  if (firstCall) {
    fieldNames = Object.keys(values).filter((f) => f !== "id");
    const missing = Object.keys(spec).filter((f) => !(f in values));
    const defaults = await defaultGet(env, model, missing);
    for (const name of missing) {
      if (name in defaults) { values[name] = defaults[name]; fieldNames.push(name); }
      else {
        const field = def.fields.get(name);
        if (!field) throw new OdooError("builtins.KeyError", name); // models.py onchange `self._fields[name]`
        if (!field.compute || field.depends.length) values[name] = false;
      }
    }
  }
  const initial: Record<string, unknown> = { ...values };
  const changed: Record<string, unknown> = {};
  for (const f of fieldNames) { changed[f] = initial[f]; delete initial[f]; }
  const delegates = DELEGATE_PARENT_MODELS.has(model);
  // models.py:2301-2304: do not force delegate fields to False
  if (delegates) for (const link of def.inherits.values()) if (link in initial && !initial[link]) delete initial[link];

  let rec: NewRec;
  if (ids.length) {
    rec = new NewRec(env, def, ids[0]!);
    // models.py:2307: the cache of the new record starts with the values of self for the specification
    for (const name of Object.keys(spec)) {
      const field = def.fields.get(name);
      if (!field) continue;
      if (!env.su && !(await hasFieldAccess(env, field))) continue;
      rec.put(name, await rec.originRec!.get(name));
    }
    // models.py:2312 `record._update_cache(initial_values)` validates, as for the changed values below
    for (const [k, v] of Object.entries(initial)) await putClient(rec, def, k, await validatedHtml(env, def, k, v));
  } else {
    for (const f of fieldNames) initial[f] = false;
    const created = rec = new NewRec(env, def, null);
    // fields.py:1855-1870: a field of a new record that nobody assigned reads its default (`default_get`, which
    // includes the context's `default_<name>`: a sub-task's `default_parent_id` when parent_id is not in the form)
    created.defaultOf = async (name) => {
      const field = def.fields.get(name)!;
      if (!fieldDefault(model, name) && !(await hasGeneratedDefault(env, model, name)) && !(await hasResolvedDefault(env, model, name))
        && !(`default_${name}` in env.context)) return undefined;
      const defaults = await defaultGet(env, model, [name]);
      return name in defaults ? clientToCache(created, field, defaults[name]) : undefined;
    };
    // fields.py:1974-1986 on the new parent of a delegate link (product.product's template)
    created.parentDefaultOf = async (parent, name) => {
      const parentModel = parent.def.name;
      const field = parent.def.fields.get(name)!;
      if (!fieldDefault(parentModel, name) && !(await hasGeneratedDefault(env, parentModel, name)) && !(await hasResolvedDefault(env, parentModel, name))) return undefined;
      const defaults = await defaultGet(env, parentModel, [name]);
      return name in defaults ? clientToCache(parent, field, defaults[name]) : undefined;
    };
    for (const [k, v] of Object.entries(initial)) await putClient(rec, def, k, v);
  }
  // models.py:2318-2326: make parent records match with the form values
  if (delegates) {
    for (const name of Object.keys(initial)) {
      const via = rec.delegateLink(name);
      if (via) (await rec.delegateParent(via)).put(name, await rec.get(name));
    }
  }

  const snapshot0 = await Snapshot.of(rec, spec, !firstCall);
  // web/models/models.py:2338 `record._update_cache(changed_values)` validates (the initial values of `new()` do not):
  // an html field's value is sanitized (fields_textual.py:731 `_validated_cache_value`), e.g. a rendered default
  for (const [k, v] of Object.entries(changed)) await putClient(rec, def, k, await validatedHtml(env, def, k, v));
  for (const f of fieldNames) if (f in spec) await snapshot0.fetch(f);

  let todo = firstCall ? [...new Set([...fieldNames, ...Object.keys(spec)])] : [...fieldNames];
  const done = new Set<string>();
  // models.py:2346-2354: the modified fields (and their co-computed fields) are protected while marking
  const protectedFields = new Set<string>();
  for (const f of fieldNames) for (const c of coComputed(def, def.fields.get(f)!)) protectedFields.add(c);
  for (const p of protectedFields) rec.protectedFields.add(p);
  await rec.modified(firstCall ? [...def.fields.keys()] : todo);
  // models.py:2355-2363: an inherited field to do is assigned on the parent explicitly
  if (delegates) {
    for (const name of todo) {
      const via = rec.delegateLink(name);
      if (via) await (await rec.delegateParent(via)).set(name, await rec.get(name));
    }
  }
  rec.protectedFields.clear();

  const warnings: [string, string, string][] = [];
  for (let guard = 0; todo.length; guard++) {
    if (guard > 50) throw new NotPorted(`onchange of ${model} did not converge`);
    const visited = new Set<unknown>();
    for (const name of todo) {
      // Odoo's methods for the field (gen/onchange_methods.py); an unported one refuses the onchange
      const steps = await onchangeSteps(env, model, name);
      for (const m of steps) {
        if (visited.has(m.fn)) continue;
        const res = await m.fn(env, rec);
        if (res) warnings.push([res.title || "Warning", res.message || "", res.type || ""]);
      }
      for (const m of steps) visited.add(m.fn);
      done.add(name);
    }
    if (env.context["recursive_onchanges"] === false) break;
    const next: string[] = [];
    for (const name of Object.keys(spec)) if (!done.has(name) && await snapshot0.hasChanged(name)) next.push(name);
    todo = next;
  }

  const snapshot1 = await Snapshot.of(rec, spec);
  const result: OnchangeResult = { value: await snapshot1.diff(snapshot0, firstCall) };
  const unique = [...new Map(warnings.map((w) => [JSON.stringify(w), w])).values()];
  if (unique.length === 1) {
    const [title, message, type] = unique[0]!;
    result.warning = { title, message, type: type || "dialog" };
  } else if (unique.length > 1) {
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated onchange warnings (${env.lang})`);
    result.warning = { title: "Warnings", message: unique.map(([t, m]) => `${t}\n\n${m}`).join("\n\n"), type: "dialog" };
  }
  return result;
}

async function putClient(rec: NewRec, def: ModelDef, name: string, value: unknown): Promise<void> {
  const field = def.fields.get(name);
  if (!field || name === "id") return;
  rec.put(name, await clientToCache(rec, field, value));
}

/** The `onchange` call of web/models/models.py:2189, for the models' own overrides that end in `super().onchange`. */
export async function onchangeCall(env0: Environment, ids: number[] | null, args: unknown[], kwargs0: Record<string, unknown>, model: string): Promise<OnchangeResult | Record<string, never>> {
  const { env, kwargs } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "onchange");
  const values = kwargs["values"] ?? args[0];
  const fieldNames = kwargs["field_names"] ?? args[1];
  const spec = parseSpecification(kwargs["fields_spec"] ?? args[2], "fields_spec");
  if (!isRecord(values)) throw new NotPorted("onchange values");
  const names = typeof fieldNames === "string" ? [fieldNames] : fieldNames;
  if (!Array.isArray(names) || !names.every((n): n is string => typeof n === "string")) throw new NotPorted("onchange field_names");
  return onchange(env, model, recIds, values, names, spec);
}

// a model whose class overrides `onchange` reaches this only when the port has no registration of that override
registerBaseMethod("onchange", async (env0, ids, args, kwargs0, model) => {
  await refuseUnportedOnchangeOverride(env0, model);
  return onchangeCall(env0, ids, args, kwargs0, model);
}, { apiModel: false });

/** `_update_cache` validation of a client value (fields_textual.py:731 `_validated_cache_value`): html is sanitized. */
async function validatedHtml(env: Environment, def: ModelDef, name: string, v: unknown): Promise<unknown> {
  const field = def.fields.get(name);
  return field?.type === "html" && typeof v === "string" && v !== "" && field.sanitize?.["sanitize"] ? sanitizeHtml(env, def, field, v) : v;
}
