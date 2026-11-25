/**
 * The guard for Python `create`/`write`/`unlink` overrides and `@api.ondelete` methods the port has not ported
 * (rådet runda 12, åtgärd 1), as `onchangeSteps` (src/orm/onchange_methods.ts) is for onchange and
 * `refuseUnportedCopy` (src/web/save.ts) for copy. Without it the generic ORM answered `true` to a write whose Odoo
 * model runs side effects in its override (an archived task stage left its tasks active, a won CRM stage left the
 * probabilities, a warehouse's `delivery_steps` built no picking types): silently wrong.
 *
 * gen/write_overrides.py lists, per model, the classes of the registry class's MRO that define `create`, `write` or
 * `unlink` above BaseModel, and the `@api.ondelete` methods. OVERRIDE_STATUS below says, per class and method, what
 * the port does with it, read from the Odoo source cited:
 *   - `ported`: the port has the equivalent (where), for every model listed in `models` (all when absent);
 *   - `when`: the override acts only when the values (each vals of a create) have one of these keys, and those are not
 *     ported: the call refuses then, and passes otherwise (the override is a pass-through to `super()` for the rest);
 *     with `ported`, the keys outside `when` are ported and these still refuse.
 * A class missing from the table refuses every call of the method on a model that has it.
 *
 * Scope: the client's request (`guardRequest`): the generic RPC methods `create`, `write`, `unlink`, `web_save`,
 * `web_unlink`, `action_archive`/`action_unarchive`, `name_create`, `load` and `copy` (src/web/save.ts, src/models/rpc_data.ts)
 * check the model they are called on and every x2many command in their values (the comodel's create, write and unlink
 * that BaseModel.write/create runs for them, fields_relational.py:1032-1105 and :1457-1620), before anything is
 * written, after the model's access check (Odoo's AccessError for a user without the right stays first). The writes
 * a ported method makes itself (src/models/) are not checked here: they are ports of Odoo methods that cite their
 * source and refuse what they do not port; a model-specific RPC method (registerMethod(model, "write", ...)) is its
 * own port.
 *
 * OVERRIDE_GUARD=log (start.sh) only logs what would refuse (`override-guard <db> <model> <method> <class> keys=..`):
 * the measurement that keeps the gate and the proof suite free of new refusals in paths that are identical.
 */
import { NotPorted } from "../errors";
import { parseCommands, type Command } from "./commands";
import { templateOf } from "./template";
import { OVERRIDE_STATUS } from "./override_status";
import { defaultGet } from "../web/defaults";
import type { Environment } from "./types";

interface GenOverrides {
  readonly classes: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly models: Readonly<Record<string, { readonly create?: readonly string[]; readonly write?: readonly string[]; readonly unlink?: readonly string[]; readonly ondelete?: readonly string[] }>>;
}

export interface OverrideStatus {
  /** Where the port has it (file or function); absent with `when` alone (a pass-through for the other keys). */
  readonly ported?: string;
  /** The value keys for which the override acts and the port has nothing: a call with one of them refuses. */
  readonly when?: readonly string[];
  /** The override acts (and the port has nothing) only when this holds for the records and values: it refuses then.
   *  Checked after `when` (when both are given, both must hold). ids are empty for create, values empty for unlink. */
  readonly acts?: (env: Environment, model: string, ids: readonly number[], valsList: readonly Readonly<Record<string, unknown>>[]) => Promise<boolean>;
  /** The fields of a created record `acts` reads from the record after `super().create()`: `acts` gets the values with
   *  the defaults the create adds for them (models.py:1625 `_add_missing_default_values`: the context's `default_*`,
   *  ir.default, the field's default), not only the given values (rådet runda 13, åtgärd 1: a line created with
   *  `default_order_id` on a confirmed order passed the guard and got no procurement). Absent: `acts` reads the given
   *  values (the override reads `vals` before `super()`, as project_todo's `vals.get('project_id')`). */
  readonly reads?: readonly string[];
  /** The models of the class the port covers; other models refuse. Absent: every model. */
  readonly models?: readonly string[];
  /** The Odoo source read for the decision. */
  readonly src: string;
}

type Method = "create" | "write" | "unlink" | "ondelete";

export { OVERRIDE_STATUS } from "./override_status";

const gen = new Map<string, Promise<GenOverrides>>();
/** The list of the database's template (poc_corpus: gen/out/, poc_erp and poc_erp_se: gen/out/poc_erp/; l10n_se has
 *  no create/write/unlink override). */
async function overrides(env: Environment): Promise<GenOverrides> {
  const t = await templateOf(env.cr);
  let p = gen.get(t.dir);
  if (!p) {
    p = (t.dir === "" ? import("../../gen/out/write_overrides.json") : import("../../gen/out/poc_erp/write_overrides.json"))
      .then((m) => m.default as unknown as GenOverrides);
    if (t.dir !== "" && t.dir !== "poc_erp") throw new NotPorted(`write_overrides.json of template ${t.name}`);
    gen.set(t.dir, p);
  }
  return p;
}

let mode: "refuse" | "log" = "refuse";
/** Set per request from the binding OVERRIDE_GUARD (src/http/dispatch.ts). */
export function setOverrideGuardMode(value: unknown): void {
  mode = value === "log" ? "log" : "refuse";
}

/**
 * The overrides of `model`'s `method` that the port does not cover for these records and values (MRO order): `ids` of
 * write and unlink, `valsList` the values of write ([vals]) and create; empty for unlink.
 */
export async function unportedOverrides(env: Environment, model: string, method: Method, ids: readonly number[],
  valsList: readonly Readonly<Record<string, unknown>>[]): Promise<string[]> {
  const chain = (await overrides(env)).models[model]?.[method];
  const keys = new Set(valsList.flatMap((v) => Object.keys(v)));
  const out: string[] = [];
  for (const cls of chain ?? []) {
    const st = OVERRIDE_STATUS[`${method} ${cls.replace(/^odoo\.addons\./, "")}`];
    if (!st || (st.models && !st.models.includes(model))) { out.push(cls); continue; }
    if (!st.when && !st.acts) { if (!st.ported) out.push(cls); continue; }
    const hit = st.when ? st.when.filter((k) => keys.has(k)) : [];
    if (st.when && !hit.length) continue;
    const seen = method === "create" && st.reads ? await withDefaults(env, model, st.reads, valsList) : valsList;
    if (st.acts && !(await st.acts(env, model, ids, seen))) continue;
    out.push(hit.length ? `${cls} (${hit.join(", ")})` : cls);
  }
  return out;
}

/** The values of each create with the defaults of `fields` the create adds where they are not given (models.py:1625). */
async function withDefaults(env: Environment, model: string, fields: readonly string[], valsList: readonly Readonly<Record<string, unknown>>[]): Promise<Readonly<Record<string, unknown>>[]> {
  const def = env.reg.model(model);
  const out: Readonly<Record<string, unknown>>[] = [];
  for (const vals of valsList) {
    const missing = fields.filter((f) => !(f in vals) && def.fields.has(f));
    out.push(missing.length ? { ...(await defaultGet(env, model, missing)), ...vals } : vals);
  }
  return out;
}

/** The x2many values a create gets from the context's `default_<field>` (models.py:1625 via default_get, models.py:1338):
 *  their commands run as the given ones do. */
function contextX2many(env: Environment, model: string, vals: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  const def = env.reg.model(model);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(env.context)) {
    if (!key.startsWith("default_")) continue;
    const name = key.slice(8), f = def.fields.get(name);
    if (f && (f.type === "one2many" || f.type === "many2many") && !(name in vals)) extra[name] = value;
  }
  return Object.keys(extra).length ? { ...extra, ...vals } : vals;
}

/**
 * Refuses (NotPorted) when `model`'s `method` has an override the port does not cover for these records and values;
 * `beforeRefusal` runs first (the access checks Odoo makes before the override's effects could show). In log mode it
 * only logs.
 */
export async function guardOverride(env: Environment, model: string, method: Method, ids: readonly number[],
  valsList: readonly Readonly<Record<string, unknown>>[], beforeRefusal?: () => Promise<void>): Promise<void> {
  const methods: Method[] = method === "unlink" ? ["unlink", "ondelete"] : [method];
  for (const m of methods) {
    const missing = await unportedOverrides(env, model, m, ids, valsList);
    if (!missing.length) continue;
    if (mode === "log") {
      const keys = [...new Set(valsList.flatMap((v) => Object.keys(v)))].sort().join(",");
      for (const cls of missing) console.warn(`override-guard ${env.cr.db} ${model} ${m} ${cls.split(" ")[0]} keys=${keys}`);
      continue;
    }
    if (beforeRefusal) await beforeRefusal();
    throw new NotPorted(`${m} override of ${model} (${missing[0]})`);
  }
}

/**
 * The guard for one client call of `method` on `model` (ids of write and unlink, the values of write and create) and
 * the x2many commands of its values, recursively.
 */
export async function guardRequest(env: Environment, model: string, method: "create" | "write" | "unlink", ids: readonly number[],
  valsList: readonly Readonly<Record<string, unknown>>[], beforeRefusal?: () => Promise<void>): Promise<void> {
  if (method === "unlink") return guardOverride(env, model, "unlink", ids, [], beforeRefusal);
  await guardOverride(env, model, method, ids, valsList, beforeRefusal);
  for (const vals of valsList) await guardCommands(env, model, method === "write" ? ids : [], method === "create" ? contextX2many(env, model, vals) : vals, beforeRefusal);
}

/** fields_relational.py:1032-1105 (One2many.write_batch) and :1457-1620 (Many2many.write_batch): what the commands
 *  of `vals` make the ORM call on the comodels. */
async function guardCommands(env: Environment, model: string, ids: readonly number[], vals: Readonly<Record<string, unknown>>,
  beforeRefusal?: () => Promise<void>): Promise<void> {
  const def = env.reg.model(model);
  for (const [name, value] of Object.entries(vals)) {
    const field = def.fields.get(name);
    if (!field || (field.type !== "one2many" && field.type !== "many2many") || !field.relation || !env.reg.models.has(field.relation)) continue;
    let commands: Command[];
    try { commands = parseCommands(value, name); } catch { continue; } // the ORM raises Odoo's error for it afterwards
    const co = field.relation;
    const inverse = field.type === "one2many" ? field.relationField : null;
    const cascade = inverse !== null && env.reg.model(co).fields.get(inverse)?.ondelete === "cascade";
    const removed = async (keep: readonly number[]): Promise<number[]> => {
      if (!ids.length || inverse === null) return [];
      const table = env.reg.model(co).table;
      const rows = (await env.cr.query<{ id: number }>(`SELECT id FROM "${table}" WHERE "${inverse}" = ANY($1::int[])`, [[...ids]])).rows;
      return rows.map((r) => r.id).filter((id) => !keep.includes(id));
    };
    const detach = async (lines: readonly number[]): Promise<void> => {
      if (!lines.length || inverse === null) return;
      // :1056-1060 a removed line is deleted when its inverse cascades, else its inverse is emptied
      if (cascade) await guardOverride(env, co, "unlink", lines, [], beforeRefusal);
      else await guardOverride(env, co, "write", lines, [{ [inverse]: false }], beforeRefusal);
    };
    for (const c of commands) {
      if (c.op === "create") {
        const line = inverse !== null ? { ...c.values, [inverse]: ids[0] ?? 0 } : c.values;
        await guardOverride(env, co, "create", [], [line], beforeRefusal);
        // the comodel's create keeps the context (fields_relational.py:1036), so its default_* apply there too
        await guardCommands(env, co, [], contextX2many(env, co, c.values), beforeRefusal);
      } else if (c.op === "update") {
        await guardOverride(env, co, "write", [c.id], [c.values], beforeRefusal);
        await guardCommands(env, co, [c.id], c.values, beforeRefusal);
      } else if (c.op === "delete") {
        await guardOverride(env, co, "unlink", [c.id], [], beforeRefusal);
      } else if (inverse !== null && c.op === "unlink") {
        await detach([c.id]);
      } else if (inverse !== null && c.op === "link") {
        await guardOverride(env, co, "write", [c.id], [{ [inverse]: ids[0] ?? 0 }], beforeRefusal);
      } else if (inverse !== null && (c.op === "clear" || c.op === "set")) {
        const keep = c.op === "set" ? c.ids : [];
        await detach(await removed(keep));
        const added = keep.length ? keep : [];
        if (added.length) await guardOverride(env, co, "write", added, [{ [inverse]: ids[0] ?? 0 }], beforeRefusal);
      }
    }
  }
}
