/**
 * Write-path web methods: `web_save` (odoo/addons/web/models/models.py:192), `web_unlink` (:265), `web_name_search`
 * (:47), and the ORM methods the web client calls directly: `create`, `write`, `unlink`, `name_create`
 * (odoo/odoo/orm/models.py:1575), `copy` / `copy_data` (:4954-5032), `action_archive` / `action_unarchive` (:5273).
 */
import { withOverlay } from "../orm/overlay";
import { templateKey, templateOf } from "../orm/template";
import { pyFloat } from "../orm/values";
import { PreciseDatetime } from "../orm/values";
import { translateLang } from "../models/util";
import { loadCodeTranslations } from "../orm/code_translations";
import { inX2manyCacheOrder, keepsWrittenOrder } from "../orm/x2many_order";
import { NotPorted, OdooError } from "../errors";
import { create } from "../orm/create";
import { withImageReadOrder } from "../orm/image_write";
import * as D from "../orm/domain";
import { ModelImpl } from "../orm/model";
import { emptyValue, fieldDefault } from "../orm/recompute";
import { hasGeneratedDefault } from "../orm/defaults_gen";
import { defaultGet } from "./defaults";
import type { BinaryValue, Environment, RecordValues } from "../orm/types";
import { checkUnlinkAccess, unlink, webUnlink } from "../orm/unlink";
import { guardRequest } from "../orm/override_guard";
import { checkModelAccess } from "../orm/access";
import { checkFieldAccess, hasFieldAccess } from "../orm/sql";
import { overridesOf, write } from "../orm/write";
import { envFor, intArg, isRecord, optStr, parseSpecification, recordIds } from "./common";
import { webRead } from "./read";
import { registerBaseMethod, type WebMethodFn } from "./register";
import { withDbErrors } from "../orm/sql_errors";
import type { MethodOptions } from "../http/methods";

/**
 * The access checks Odoo makes before a refused override's effects could show (src/orm/override_guard.ts): write's
 * `check_access` and field access (models.py:3848-3854), create's model access, unlink's (models.py:3666).
 */
export function guardAccess(env: Environment, model: string, method: "create" | "write" | "unlink", ids: readonly number[], vals: Record<string, unknown>): () => Promise<void> {
  return async () => {
    if (method === "write") {
      // models.py:3828 the model's write ACL first (as src/orm/write.ts write), then the records' rules
      const def = env.reg.model(model);
      if (!env.su) {
        await checkModelAccess(env, def, "write");
        await env.model(model).checkAccess([...ids], "write");
      }
      // :3851-3854 `check_field_access(field, 'write')` of the written fields
      for (const name of Object.keys(vals)) {
        const field = def.fields.get(name);
        if (field) await checkFieldAccess(env, def, field, "write");
      }
    }
    else if (method === "unlink") await checkUnlinkAccess(env, env.reg.model(model), ids);
    else if (!env.su) await checkModelAccess(env, env.reg.model(model), "create");
  };
}

/** Write methods: database integrity errors become Odoo's ValidationError (odoo/http/retrying.py:82-91). */
function registerWrite(method: string, fn: WebMethodFn, opts: MethodOptions): void {
  registerBaseMethod(method, (env, ids, args, kwargs, model) => withDbErrors(env, () => fn(env, ids, args, kwargs, model)), opts);
}

/** web/models/models.py:192 web_save. */
export async function webSave(env: Environment, model: string, ids: readonly number[], vals: Record<string, unknown>, spec: ReturnType<typeof parseSpecification>, nextId: unknown): Promise<RecordValues[]> {
  // web/models/models.py:215-229: an empty list browses no attachment and changes nothing (the key stays in context)
  const pending = env.context["pending_attachment_ids"];
  if (pending !== undefined && !(Array.isArray(pending) && pending.length === 0)) throw new NotPorted("web_save with pending attachments");
  let recIds = [...ids];
  const created = !recIds.length;
  await guardRequest(env, model, created ? "create" : "write", recIds, [vals], guardAccess(env, model, created ? "create" : "write", recIds, vals));
  // the read order of the sizes holds for a write too: only a create reads it for its own model (writeImageMixin), a
  // write for the records its inverses write (product.product's template image)
  if (recIds.length) await withImageReadOrder(env, model, Object.keys(spec), () => write(env, model, recIds, vals));
  else recIds = await withImageReadOrder(env, model, Object.keys(spec), () => create(env, model, [vals]));
  if (nextId !== undefined && nextId !== null && nextId !== false) {
    if (typeof nextId !== "number") throw new NotPorted("web_save next_id");
    recIds = [nextId];
    return webRead(env, model, recIds, spec);
  }
  const rows = await webRead(env, model, recIds, spec);
  if (created) {
    // a many2many the values leave to the context's default_<field> (models.py:1338 default_get) is cached in its order too
    const def = env.reg.model(model), given: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(env.context)) {
      const name = key.startsWith("default_") ? key.slice(8) : "";
      if (name && !(name in vals) && def.fields.get(name)?.type === "many2many") given[name] = value;
    }
    for (const row of rows) cacheOrderMany2many(env, model, { ...given, ...vals }, row);
  }
  else for (const row of rows) writtenOrderMany2many(env, model, vals, row);
  return rows;
}

/**
 * After `write`, web_read reads a many2many that was written (directly in `vals` or registered via
 * `registerWrittenOrder` when written as a side effect) from the cache, in the order the write left it
 * (src/orm/x2many_order.ts: the old ids as read, LINK appended), not the comodel's `_order` of a database read.
 */
function writtenOrderMany2many(env: Environment, model: string, vals: Record<string, unknown>, row: RecordValues): void {
  const def = env.reg.model(model);
  const id = row["id"];
  if (typeof id !== "number") return;
  for (const [name, got] of Object.entries(row)) {
    if ((!(name in vals) && !keepsWrittenOrder(model, name)) || def.fields.get(name)?.type !== "many2many" || !Array.isArray(got)) continue;
    const idOf = (v: unknown): number => Number(isRecord(v) ? v["id"] : v);
    const byId = new Map(got.map((v) => [idOf(v), v] as const));
    row[name] = inX2manyCacheOrder(env.cr, model, name, id, got.map(idOf)).map((y) => byId.get(y)!);
  }
}

/**
 * After `create`, web_read reads a many2many the values gave from the cache, where `create` put it in the order of the
 * commands (fields_relational.py `_Relational.convert_to_cache` of LINK/SET on a new record), not the comodel's `_order`
 * a database read gives. Only LINK, SET, UNLINK and CLEAR are replayed; a create command leaves the database order.
 */
function cacheOrderMany2many(env: Environment, model: string, vals: Record<string, unknown>, row: RecordValues): void {
  const def = env.reg.model(model);
  for (const [name, value] of Object.entries(vals)) {
    if (def.fields.get(name)?.type !== "many2many" || !(name in row) || !Array.isArray(value)) continue;
    let order: number[] | null = [];
    for (const c of value) {
      if (typeof c === "number") { if (!order.includes(c)) order.push(c); continue; }
      if (!Array.isArray(c)) { order = null; break; }
      const [op, id, ids] = c as [unknown, unknown, unknown];
      if (op === 4 && typeof id === "number") { if (!order.includes(id)) order.push(id); }
      else if (op === 6 && Array.isArray(ids) && ids.every((x): x is number => typeof x === "number")) order = [...new Set(ids)];
      else if ((op === 3 || op === 2) && typeof id === "number") order = order.filter((x) => x !== id);
      else if (op === 5) order = [];
      else if (op === 1) continue;
      else { order = null; break; }
    }
    const got = row[name];
    if (order === null || !Array.isArray(got) || got.length !== order.length) continue;
    const idOf = (v: unknown): unknown => (isRecord(v) ? v["id"] : v);
    const byId = new Map(got.map((v) => [idOf(v), v] as const));
    if (!order.every((id) => byId.has(id))) continue;
    row[name] = order.map((id) => byId.get(id)!);
  }
}

function valsArg(v: unknown, what: string): Record<string, unknown> {
  if (!isRecord(v)) throw new NotPorted(`${what}: values of type ${typeof v}`);
  return v;
}

registerWrite("web_save", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "web_save");
  const vals = valsArg(kwargs["vals"] ?? args[0], "web_save");
  const spec = parseSpecification(kwargs["specification"] ?? args[1]);
  return webSave(env, model, recIds, vals, spec, kwargs["next_id"] ?? args[2]);
}, { apiModel: false });

/**
 * web/models/models.py:540-563 web_resequence: `[]` when the model has no `field_name`, otherwise one
 * `write({field_name: i})` per record in the order of the ids, i counting from `offset`, then `web_read`.
 */
registerWrite("web_resequence", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  // mrp_workorder.py:839 overrides it (sequences the production's workorders); not ported
  if (model === "mrp.workorder") throw new NotPorted("web_resequence override of mrp.workorder");
  const recIds = recordIds(ids, [], "web_resequence");
  const spec = parseSpecification(kwargs["specification"] ?? args[0]);
  const rawField = "field_name" in kwargs ? kwargs["field_name"] : args.length > 1 ? args[1] : "sequence";
  // `None`/`False` are not in `self._fields` either
  const fieldName = optStr(rawField, "web_resequence field_name");
  const offset = intArg(kwargs["offset"] ?? args[2], "web_resequence offset", 0);
  if (fieldName === null || !env.reg.model(model).fields.has(fieldName)) return [];
  for (const [i, id] of recIds.entries()) {
    const vals = { [fieldName]: offset + i };
    await guardRequest(env, model, "write", [id], [vals], guardAccess(env, model, "write", [id], vals));
    await write(env, model, [id], vals);
  }
  return webRead(env, model, recIds, spec);
}, { apiModel: false });

registerWrite("web_unlink", async (env0, ids, _args, kwargs0, model) => {
  const { env } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "web_unlink");
  await guardRequest(env, model, "unlink", recIds, [], guardAccess(env, model, "unlink", recIds, {}));
  return webUnlink(env, model, recIds);
}, { apiModel: false });

registerWrite("create", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const raw = kwargs["vals_list"] ?? args[0];
  const list = Array.isArray(raw) ? raw : [raw];
  const valsList = list.map((v) => valsArg(v, "create"));
  await guardRequest(env, model, "create", [], valsList, guardAccess(env, model, "create", [], {}));
  const ids = await create(env, model, valsList);
  // models.py:4088 returns the records; RPC serialises a recordset as its ids (or the id for a single dict)
  return Array.isArray(raw) ? ids : ids[0];
}, { apiModel: true });

registerWrite("write", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "write"), vals = valsArg(kwargs["vals"] ?? args[0], "write");
  await guardRequest(env, model, "write", recIds, [vals], guardAccess(env, model, "write", recIds, vals));
  await write(env, model, recIds, vals);
  return true;
}, { apiModel: false });

registerWrite("unlink", async (env0, ids, _args, kwargs0, model) => {
  const { env } = envFor(env0, kwargs0);
  const recIds = recordIds(ids, [], "unlink");
  await guardRequest(env, model, "unlink", recIds, [], guardAccess(env, model, "unlink", recIds, {}));
  await unlink(env, model, recIds);
  return true;
}, { apiModel: false });

/** models.py:1575 name_create (generic): create({rec_name: name}), then (id, display_name). */
export async function nameCreate(env: Environment, model: string, name: string): Promise<[number, string] | false> {
  const override = overridesOf(model).nameCreate;
  if (override) return override(env, name);
  const def = env.reg.model(model);
  if (!def.recName) throw new NotPorted(`Cannot name_create on ${model}`);
  await guardRequest(env, model, "create", [], [{ [def.recName]: name }], guardAccess(env, model, "create", [], {}));
  const [id] = await create(env, model, [{ [def.recName]: name }]);
  const names = await env.model(model).displayName([id!]);
  return [id!, names.get(id!) ?? ""];
}

registerWrite("name_create", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const name = kwargs["name"] ?? args[0];
  if (typeof name !== "string") throw new NotPorted("name_create with a non-string name");
  return nameCreate(env, model, name);
}, { apiModel: true });

const MAGIC = new Set(["id", "create_uid", "create_date", "write_uid", "write_date", "parent_path"]);

/**
 * The models whose copy is not BaseModel's (gen/copy_overrides.py): `copy`/`copy_data` defined by a module, or fields
 * with a `copy` callable. The generic copy below refuses them unless the override is ported (PORTED_COPY, the
 * `copyData` override of src/orm/write.ts) and the callable is `mark_as_copy` of a `name`/`x_name` char field.
 */
interface CopyOverrides { models: Record<string, { methods: string[]; callable_copy_fields: string[] }> }
const COPY_OVERRIDES = new Map<string, Promise<CopyOverrides>>();
/** mail_alias_mixin_optional.py:150-156 `copy_data`: drops the mail.alias fields outside ALIAS_WRITEABLE_FIELDS (:19). */
const ALIAS_MIXIN_COPY = "copy_data:odoo.addons.mail.models.mail_alias_mixin_optional";
const ALIAS_WRITEABLE_FIELDS = new Set(["alias_domain_id", "alias_name", "alias_contact", "alias_defaults", "alias_bounced_content"]);

/**
 * The database's template's copy overrides: poc_erp's, with a site's overlay of them (gen/out/<overlay>/
 * copy_overrides.json, worker/gen/template_delta.py: its new modules' `copy`/`copy_data` and callable copies). A site
 * built without one refuses (src/gen_assets.ts: not packaged) rather than copying past a module's override.
 */
async function loadCopyOverrides(env: Environment): Promise<CopyOverrides> {
  const t = await templateOf(env.cr);
  let p = COPY_OVERRIDES.get(templateKey(t));
  if (!p) {
    p = import("../../gen/out/poc_erp/copy_overrides.json").then((m) => withOverlay(t, "copy_overrides.json", m.default as unknown as CopyOverrides, "models"));
    COPY_OVERRIDES.set(templateKey(t), p);
  }
  return p;
}

/**
 * A translated field's stored translations as copy_data gives them (models.py:5009-5012 `translations.normalize`, a
 * StoredTranslations dict; translate.py:575-620). create takes it back as the same dict; the port writes it as the
 * plain en_US value (convert.ts), which stores the same dict only when en_US is its one language and the creating
 * environment's language is en_US (checked by `copyValuesForCreate`).
 */
export class CopiedTranslations {
  constructor(readonly values: Readonly<Record<string, string>>) {}
}

/**
 * translate.py:966-973 `mark_as_copy` of a translated field: `adapt_translated_field_value` (:918-946) keeps en_US and
 * the active languages, each `record.with_context(lang=lang).env._('%s (copy)', v)`; the `_` is called from
 * odoo/tools/translate.py, so its module is base (base/i18n: "%s (copie)" in fr_FR).
 */
export async function markAsCopyTranslations(env: Environment, values: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const active = new Set((await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active")).rows.map((r) => r.code));
  const out: Record<string, string> = {};
  for (const [lang, v] of Object.entries(values)) {
    if (lang !== "en_US" && !active.has(lang)) continue;
    if (lang !== "en_US") await loadCodeTranslations(env.cr, lang);
    const pattern = translateLang(lang, "%s (copy)", "base");
    if (pattern.split("%").length !== 2 || !pattern.includes("%s")) throw new NotPorted(`"(copy)" suffix pattern ${JSON.stringify(pattern)} in ${lang}`);
    out[lang] = pattern.replace("%s", () => v);
  }
  return out;
}

/** The values of copy_data for create: CopiedTranslations as the plain value (see there), also in nested creates. */
export function copyValuesForCreate(env: Environment, model: string, vals: Record<string, unknown>): Record<string, unknown> {
  const def = env.reg.model(model);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vals)) {
    if (v instanceof CopiedTranslations) {
      const langs = Object.keys(v.values);
      if (langs.length !== 1 || langs[0] !== "en_US" || (env.lang && env.lang !== "en_US")) {
        throw new NotPorted(`create of copied translations of ${model}.${k} in ${langs.join(", ")} (translated dict values)`);
      }
      out[k] = v.values["en_US"]!;
    } else if (Array.isArray(v) && v.length === 0 && def.fields.get(k)?.type === "properties_definition") {
      out[k] = false; // fields_properties.py PropertiesDefinition.convert_to_column: an empty definition is NULL
    } else if (Array.isArray(v) && def.fields.get(k)?.type === "one2many") {
      out[k] = v.map((c) => (Array.isArray(c) && c[0] === 0 && isRecord(c[2]) ? [0, 0, copyValuesForCreate(env, def.fields.get(k)!.relation!, c[2])] : c));
    } else out[k] = v;
  }
  return out;
}
const PORTED_COPY: Readonly<Record<string, readonly string[]>> = {
  "sale.order": ["copy_data:odoo.addons.sale.models.sale_order"],
  "sale.order.line": ["copy_data:odoo.addons.sale_project.models.sale_order_line"],
  "crm.lead": ["copy_data:odoo.addons.crm.models.crm_lead"],
  // the date_planned rewrite of its copy is the purchase.order copy method (src/models/purchase_flow.ts)
  "purchase.order": ["copy:odoo.addons.purchase.models.purchase_order"],
  // src/models/payment_flow.ts copyProviders (the copy with its payment methods; the "(copy)" name refuses)
  "payment.provider": ["copy:odoo.addons.payment.models.payment_provider", "copy_data:odoo.addons.payment.models.payment_provider",
    "copy_data:odoo.addons.payment_custom.models.payment_provider"],
  // src/models/task_copy.ts
  "project.task": ["copy:odoo.addons.project.models.project_task", "copy_data:odoo.addons.project.models.project_task"],
  // src/models/account_move_copy.ts
  "account.move": ["copy:odoo.addons.account.models.account_move", "copy_data:odoo.addons.stock_account.models.account_move", "copy_data:odoo.addons.account.models.account_move"],
  "account.move.line": ["copy_data:odoo.addons.account.models.account_move_line"],
  // src/models/account_journal_create.ts copyData (the unique code) + generic ALIAS_MIXIN_COPY
  "account.journal": ["copy_data:odoo.addons.account.models.account_journal", ALIAS_MIXIN_COPY],
  // src/models/project_copy.ts; mail_alias_mixin_optional's copy_data is the generic ALIAS_MIXIN step below
  "project.project": ["copy:odoo.addons.project.models.project_project", "copy_data:odoo.addons.project.models.project_project", ALIAS_MIXIN_COPY],
  "project.milestone": ["copy:odoo.addons.project.models.project_milestone"],
  // src/models/product_template_edit.ts (the pricelist rules; attribute lines and storage capacities refuse)
  "product.template": ["copy:odoo.addons.stock.models.product", "copy:odoo.addons.product.models.product_template"],
  // mail_alias_mixin_optional's copy_data (the generic ALIAS_MIXIN step below) is crm.team's only one
  "crm.team": [ALIAS_MIXIN_COPY],
  // src/models/calendar_computes.ts copyEvents
  "calendar.event": ["copy:odoo.addons.calendar.models.calendar_event"],
  // src/models/res_users_create.ts (copy with no_reset_password, copy_data's "(copy)" name and login)
  "res.users": ["copy:odoo.addons.auth_signup.models.res_users", "copy_data:odoo.addons.base.models.res_users"],
};

async function refuseUnportedCopy(env: Environment, model: string, copyDataOnly = false): Promise<void> {
  const o = (await loadCopyOverrides(env)).models[model];
  if (!o) return;
  const ported = PORTED_COPY[model] ?? [];
  // a `copy` override is not on the way of a bare `copy_data()` call
  const missing = o.methods.filter((m) => !ported.includes(m) && !(copyDataOnly && m.startsWith("copy:")));
  if (missing.length) throw new NotPorted(`copy of ${model} (${missing.join(", ")})`);
  const callables = o.callable_copy_fields.filter((f) => !COPY_SUFFIX_FIELDS.has(f));
  if (callables.length) throw new NotPorted(`copy of ${model}: copy callable of ${callables.join(", ")}`);
}

/** models.py:4954-5022 copy_data of records copied on their own (none of them is seen twice). */
export async function copyData(env: Environment, model: string, ids: readonly number[], defaults: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out = await copyDataSeen(env, model, ids, defaults);
  if (out.some((v) => v === null)) throw new NotPorted(`copy of ${model}: a record copied twice`);
  return out as Record<string, unknown>[];
}

/** `records.copy_data(defaults)` called by Odoo code itself (no `copy()` around it: its overrides are not run). */
export async function copyDataOnly(env: Environment, model: string, ids: readonly number[], defaults: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const out = await copyDataSeen(env, model, ids, defaults, true);
  if (out.some((v) => v === null)) throw new NotPorted(`copy_data of ${model}: a record copied twice`);
  return out as Record<string, unknown>[];
}

/** copy_data with `__copy_data_seen`: a record already copied in this copy gives null (None). */
async function copyDataSeen(env0: Environment, model: string, ids: readonly number[], given: Record<string, unknown>, bare = false, checkFieldRead = false): Promise<(Record<string, unknown> | null)[]> {
  const def = env0.reg.model(model);
  const defaults = overridesOf(model).copyDefaults?.(given) ?? given;
  await refuseUnportedCopy(env0, model, bare);
  const overrides = (await loadCopyOverrides(env0)).models[model];
  const callableCopy = new Set(overrides?.callable_copy_fields ?? []);
  // :4968-4979 the `_inherits` link fields are not copied; a parent given by the default brings all its fields
  const blacklist = new Set<string>();
  const parentsGiven = new Set<string>();
  for (const [parent, link] of def.inherits) {
    blacklist.add(link);
    if (link in defaults) parentsGiven.add(parent);
    else if (env0.reg.model(parent).inherits.size) throw new NotPorted(`copy_data through nested _inherits (${model} -> ${parent})`);
  }
  // :4963-4965 `__copy_data_seen`: records already copied in this copy (circular relations) give None
  const seen = (env0.context["__copy_data_seen"] as Record<string, number[]> | undefined) ?? {};
  const env = "__copy_data_seen" in env0.context ? env0 : env0.withContext({ ...env0.context, __copy_data_seen: seen });
  const m = new ModelImpl(env, def);
  await m.checkAccess(ids, "read");
  const out: (Record<string, unknown> | null)[] = [];
  for (const id of ids) {
    const done = (seen[model] ??= []);
    if (done.includes(id)) {
      out.push(null);
      continue;
    }
    done.push(id);
    const vals: Record<string, unknown> = { ...defaults };
    for (const field of def.fields.values()) {
      const name = field.name;
      if (!field.copy || name in defaults || MAGIC.has(name) || blacklist.has(name)) continue;
      if (field.inheritedFrom !== null && parentsGiven.has(field.inheritedFrom)) continue;
      if (!env.su && field.noAccess) continue;
      if (checkFieldRead && !env.su && !(await hasFieldAccess(env, field))) continue;
      if (!field.store && !field.compute && !field.related) {
        // fields.py:1973-1985 `__get__` of a non-stored, non-computed field: its `default_get` value, else empty
        // (before round 11 always empty: sale.order.line.analytic_precision read False where Odoo has 2)
        const has = `default_${name}` in env.context || fieldDefault(model, name) !== undefined || await hasGeneratedDefault(env, model, name)
          || (await env.cr.query("SELECT 1 FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = $1 AND f.name = $2 LIMIT 1", [model, name])).rows.length > 0;
        if (has && ["one2many", "many2many", "many2one", "binary", "image", "properties"].includes(field.type)) throw new NotPorted(`copy_data of the default of the non-stored ${field.type} ${model}.${name}`);
        const d = has ? (await defaultGet(env, model, [name]))[name] : undefined;
        vals[name] = d === undefined || d === null ? false : d;
        continue;
      }
      const value = (await new ModelImpl(env.sudo(), def).values([id], field)).get(id) ?? emptyValue(field);
      if (callableCopy.has(name)) {
        // fields_textual.py:529-533: a name/x_name char field without its own `copy` gets `mark_as_copy(name)`
        // (translate.py:954-976): False stays False, else env._('%s (copy)', value); translated: each stored language
        if (!COPY_SUFFIX_FIELDS.has(name) || field.type !== "char") throw new NotPorted(`copy callable of ${model}.${name}`);
        if (field.translate) {
          const stored = await storedTranslations(env, model, def.table, id, field.name);
          vals[name] = stored === null ? false : new CopiedTranslations(await markAsCopyTranslations(env, stored.values));
          continue;
        }
        if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated "(copy)" suffix (${env.lang})`);
        vals[name] = value === null || value === false ? false : `${String(value)} (copy)`;
      } else if (field.type === "one2many") {
        // :5001-5006 the lines in id order, each `Command.create(line)` of their own copy_data
        const lines = [...(value as number[])].sort((a, b) => a - b);
        const linesVals = lines.length ? await copyDataSeen(env, field.relation!, lines, {}, false, checkFieldRead) : [];
        vals[name] = linesVals.filter((l): l is Record<string, unknown> => l !== null).map((l) => [0, 0, l]);
      } else if (field.type === "many2many") {
        // [Command.set(record[name]._filtered_access('read').ids)]
        const coIds = value as number[];
        const visible = coIds.length ? await env.model(field.relation!).search(D.cond("id", "in", coIds), { activeTest: false }) : [];
        vals[name] = [[6, 0, coIds.filter((c) => visible.includes(c))]];
      } else if (field.translate) {
        // :5007-5012 the stored translations (`normalize`d) of a `translate=True` field; term translations refuse
        // (an inherited field's translations are its parent's, models.py:2993-3007 through the related path)
        const { translateKind } = await import("../orm/genmeta");
        let owner = model, table = def.table, rid: number | null = id;
        if (field.inheritedFrom !== null) {
          const link = def.inherits.get(field.inheritedFrom);
          if (link === undefined || env.reg.model(field.inheritedFrom).fields.get(name)?.column !== true) throw new NotPorted(`copy of translated field ${model}.${name}`);
          owner = field.inheritedFrom;
          table = env.reg.model(owner).table;
          rid = (await env.cr.query<{ p: number | null }>(`SELECT "${link}" AS p FROM "${def.table}" WHERE id = $1`, [id])).rows[0]?.p ?? null;
        } else if (field.column !== true) throw new NotPorted(`copy of translated field ${model}.${name}`);
        const stored = rid === null ? null : await storedTranslations(env, owner, table, rid, name);
        const kind = await translateKind(env, owner, name);
        if (kind !== "model") {
          // :5014-5017 a term-translated field: `translations.translated(env, field, 'en_US', {lang: {} for active
          // langs})` (translate.py:771-...): `_validate(check_structure=False, auto_fix=True)`, then each active
          // language's technical value (`_<lang>`) promoted; no term update, so nothing else changes
          const term = rid === null ? null : await storedTranslations(env, owner, table, rid, name, true);
          vals[name] = term === null ? false : term;
        } else if (stored === null) vals[name] = false; // :5008-5009 no translations: False
        else vals[name] = stored;
      } else if (field.type === "binary" || field.type === "image") {
        // `record[name]`: the content in base64 (fields_binary.py convert_to_record of an attachment or a column),
        // which create writes again (an image through `_image_process`, src/orm/image_write.ts)
        vals[name] = value ? Buffer.from(await (value as BinaryValue).content()).toString("base64") : false;
      } else if (field.type === "properties_definition") {
        // fields_properties.py PropertiesDefinition: an empty definition reads as [] (convert_to_write of the cache)
        if (value !== null && value !== false && (!Array.isArray(value) || value.length)) throw new NotPorted(`copy of properties definition ${model}.${name}`);
        vals[name] = [];
      } else if (field.type === "properties") {
        if (value && (!Array.isArray(value) || value.length)) throw new NotPorted(`copy of properties ${model}.${name}`);
        vals[name] = false;
      } else if (field.type === "datetime" && field.column && value) {
        // the column's microseconds, as Odoo's cache holds them (PreciseDatetime)
        const raw = (await env.cr.query<{ v: string | null }>(`SELECT "${name}"::text AS v FROM "${def.table}" WHERE id = $1`, [id])).rows[0]?.v ?? null;
        vals[name] = raw && /\.\d+$/.test(raw) ? new PreciseDatetime(raw) : value;
      } else {
        vals[name] = value === null ? false : value;
      }
    }
    out.push(vals);
  }
  if (overrides?.methods.includes(ALIAS_MIXIN_COPY)) {
    const aliasFields = [...env.reg.model("mail.alias").fields.keys()].filter((f) => !ALIAS_WRITEABLE_FIELDS.has(f));
    for (const vals of out) if (vals) for (const f of aliasFields) delete vals[f];
  }
  const override = overridesOf(model).copyData;
  if (override) {
    if (out.some((v) => v === null)) throw new NotPorted(`copy_data override of ${model} with a record seen twice`);
    await override(env, ids, out as Record<string, unknown>[], given);
  }
  return out;
}

const COPY_SUFFIX_FIELDS = new Set(["name", "x_name"]);

/**
 * `record._get_stored_translations(name)` normalized (translate.py:575-620): null for a NULL column; the languages
 * that are active (or en_US) with their string values. Values that `_validate` would fix otherwise (None values,
 * missing en_US) refuse.
 */
async function storedTranslations(env: Environment, model: string, table: string, id: number, name: string, term = false): Promise<CopiedTranslations | null> {
  const raw = (await env.cr.query<{ v: Record<string, unknown> | null }>(`SELECT "${name}" AS v FROM "${table}" WHERE id = $1`, [id])).rows[0]?.v ?? null;
  if (raw === null) return null;
  const active = new Set((await env.cr.query<{ code: string }>("SELECT code FROM res_lang WHERE active")).rows.map((r) => r.code));
  const valid = (lang: string): boolean => lang === "en_US" || active.has(lang);
  const values: Record<string, string> = {};
  for (const [lang, v] of Object.entries(raw)) {
    // invalid languages are dropped silently (:593-600); a term-translated field also keeps the technical `_<lang>`
    if (!(valid(lang) || (term && lang.startsWith("_") && valid(lang.slice(1))))) continue;
    if (typeof v !== "string") throw new NotPorted(`stored translations of ${model}.${name} with a ${v === null ? "None" : typeof v} value`);
    values[lang] = v;
  }
  if (!("en_US" in values)) throw new NotPorted(`stored translations of ${model}.${name} without en_US`);
  if (term) {
    // translate.py:810-814 the technical value of each active language (and en_US) replaces its value
    for (const lang of Object.keys(values)) {
      if (!lang.startsWith("_")) continue;
      values[lang.slice(1)] = values[lang]!;
      delete values[lang];
    }
  }
  return new CopiedTranslations(values);
}

/** models.py:5025 copy: copy_data with active_test=False, then create. */
export async function copy(env: Environment, model: string, ids: readonly number[], defaults: Record<string, unknown>, guard = false): Promise<number[]> {
  const data = await copyData(env.withContext({ ...env.context, active_test: false }), model, ids, defaults);
  // a top-level translated column copied in several languages, in an en_US environment: created with its en_US value, then the column holds the copied mapping, as create stores a StoredTranslations value (the
  // translations dict as the column's jsonb, fields_textual.py convert_to_column)
  const def = env.reg.model(model);
  const full: Map<string, Readonly<Record<string, string>>>[] = data.map((v) => {
    const m = new Map<string, Readonly<Record<string, string>>>();
    for (const [k, x] of Object.entries(v)) {
      if (!(x instanceof CopiedTranslations)) continue;
      const langs = Object.keys(x.values);
      if (langs.length === 1 && langs[0] === "en_US") continue;
      // in another environment language the create would write that language's value: refused (copyValuesForCreate)
      if (env.lang && env.lang !== "en_US") continue;
      const f = def.fields.get(k);
      if (!f || f.column !== true || f.inheritedFrom !== null) continue;
      m.set(k, x.values);
      v[k] = new CopiedTranslations({ en_US: x.values["en_US"]! });
    }
    return m;
  });
  const valsList = data.map((v) => copyValuesForCreate(env, model, v));
  // the client's copy: the create of the copies runs the model's create overrides (src/orm/override_guard.ts)
  if (guard) await guardRequest(env, model, "create", [], valsList, guardAccess(env, model, "create", [], {}));
  const created = await create(env, model, valsList);
  for (let i = 0; i < created.length; i++) {
    for (const [k, values] of full[i]!) {
      await env.cr.query(`UPDATE "${def.table}" SET "${k}" = $1::jsonb WHERE id = $2`, [JSON.stringify(values), created[i]]);
    }
  }
  return created;
}

registerWrite("copy", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && !isRecord(dflt)) throw new NotPorted("copy default");
  return copy(env, model, recordIds(ids, [], "copy"), isRecord(dflt) ? dflt : {}, true);
}, { apiModel: false });

/**
 * models.py:4954-5022 `copy_data(default=None)` called over RPC: the values `copy` would create, one dict per record
 * (with active_test as the caller's context). Before round 11 only `copy` was registered, so copy_data answered "not
 * registered" for every model.
 */
registerWrite("copy_data", async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (args.length > 1) throw new NotPorted("copy_data with more than one positional argument");
  const dflt = kwargs["default"] ?? args[0];
  if (dflt !== undefined && dflt !== null && dflt !== false && !isRecord(dflt)) throw new NotPorted("copy_data default");
  const raw = await copyDataSeen(env, model, recordIds(ids, [], "copy_data"), isRecord(dflt) ? dflt : {}, false, true);
  if (raw.some((v) => v === null)) throw new NotPorted(`copy_data of ${model}: a record copied twice`);
  const out: Record<string, unknown>[] = [];
  for (const v of raw as Record<string, unknown>[]) out.push(await copyDataForRpc(env, model, v));
  return out;
}, { apiModel: false });

/** The values as Python's JSON writes them: a Float field's number is a float (295.0), also in the lines' commands. */
async function copyDataForRpc(env: Environment, model: string, vals: Record<string, unknown>): Promise<Record<string, unknown>> {
  const def = env.reg.model(model);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vals)) {
    const f = def.fields.get(k);
    if (!env.su && f && !(await hasFieldAccess(env, f))) continue;
    if (v instanceof CopiedTranslations) out[k] = { ...v.values };
    else if (f && (f.type === "float" || f.type === "monetary") && typeof v === "number") out[k] = pyFloat(v);
    else if (f && f.type === "one2many" && Array.isArray(v)) {
      const mapped: unknown[] = [];
      for (const c of v) {
        mapped.push(Array.isArray(c) && c[0] === 0 && isRecord(c[2]) ? [0, 0, await copyDataForRpc(env, f.relation!, c[2])] : c);
      }
      out[k] = mapped;
    } else out[k] = v;
  }
  return out;
}

/** models.py:5273-5291 `action_archive`/`action_unarchive`: the records whose active flag differs are written. */
export async function setActiveOf(env: Environment, model: string, ids: readonly number[], active: boolean): Promise<null> {
  return setActive(env, model, ids, active);
}

async function setActive(env: Environment, model: string, ids: readonly number[], active: boolean): Promise<null> {
  const def = env.reg.model(model);
  const name = def.activeName;
  if (!name) throw new NotPorted(`No 'active' field on model ${model}`);
  if (!env.su) {
    await checkModelAccess(env, def, "write");
    if (ids.length) await new ModelImpl(env, def).checkAccess(ids, "write");
  }
  // records.filtered(lambda r: r[active]) reads the records (access checked above and by write)
  const values = await new ModelImpl(env.sudo(), def).values(ids, def.fields.get(name)!);
  const todo = ids.filter((id) => values.has(id) && (values.get(id) === true) === !active);
  const missing = ids.filter((id) => !values.has(id));
  if (missing.length) throw new NotPorted(`action_${active ? "un" : ""}archive on missing records`);
  if (todo.length) {
    await guardRequest(env, model, "write", todo, [{ [name]: active }], guardAccess(env, model, "write", todo, { [name]: active }));
    await write(env, model, todo, { [name]: active });
  }
  return null;
}

registerWrite("action_archive", async (env0, ids, _args, kwargs0, model) => {
  const { env } = envFor(env0, kwargs0);
  return setActive(env, model, recordIds(ids, [], "action_archive"), false);
}, { apiModel: false });

registerWrite("action_unarchive", async (env0, ids, _args, kwargs0, model) => {
  const { env } = envFor(env0, kwargs0);
  return setActive(env, model, recordIds(ids, [], "action_unarchive"), true);
}, { apiModel: false });

/** web/models/models.py:47 web_name_search: name_search, web_read, `__formatted_display_name`. */
registerBaseMethod("web_name_search", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const name = optStr(kwargs["name"] ?? args[0], "name") ?? "";
  const spec = parseSpecification(kwargs["specification"] ?? args[1]);
  const domain = D.parseDomain(kwargs["domain"] ?? args[2]);
  const operator = optStr(kwargs["operator"] ?? args[3], "operator") ?? "ilike";
  const limitRaw = kwargs["limit"] ?? args[4];
  const limit = limitRaw === undefined ? 100 : intArg(limitRaw, "limit", 100);
  const pairs = await env.model(model).nameSearch(name, domain, operator, limit);
  const ids = pairs.map(([id]) => id);
  const rows = await webRead(env, model, ids, spec);
  if ("display_name" in spec) {
    // `record.with_context(formatted_display_name=True).display_name`: the cache key of display_name only holds the
    // context keys of its depends_context (environments.py:501-527 `cache_key`), so without that key it is the value web_read
    // just computed
    if (!env.reg.model(model).fields.get("display_name")?.dependsContext?.includes("formatted_display_name")) {
      for (const row of rows) row["__formatted_display_name"] = row["display_name"] ?? false;
    } else {
      const def = env.reg.model(model);
      const formatted = await new ModelImpl(env.withContext({ ...env.context, formatted_display_name: true }), def).values(ids, def.fields.get("display_name")!);
      for (const row of rows) row["__formatted_display_name"] = formatted.get(Number(row["id"])) ?? false;
    }
  }
  return rows;
}, { apiModel: true, readonly: true });

/**
 * models.py:3464-3500 `has_access(operation)`: whether the user may do `operation` on all the records (model access,
 * then the record rules), as a boolean. The ids come from `args[0]` (call_kw) or the caller (json2).
 */
registerBaseMethod("has_access", async (env0, ids0, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  let ids: unknown = ids0, rest = args;
  if (ids0 === null) {
    const [first, ...others] = args;
    rest = others;
    ids = typeof first === "number" ? [first] : first === undefined || first === false || first === null ? [] : first;
  }
  const operation = rest[0] ?? kwargs["operation"];
  if (operation === undefined) throw new OdooError("builtins.TypeError", "BaseModel.has_access() missing 1 required positional argument: 'operation'");
  if (!Array.isArray(ids) || !ids.every((x): x is number => typeof x === "number")) throw new NotPorted("has_access on ids that are not integers (browse)");
  if (!["read", "write", "create", "unlink"].includes(String(operation))) throw new NotPorted(`has_access of operation ${String(operation)}`);
  if (env.su) return true;
  const def = env.reg.model(model);
  if (ids.length) {
    const found = await new ModelImpl(env.sudo(), def).search(D.cond("id", "in", ids), { activeTest: false });
    if (found.length !== new Set(ids).size) throw new NotPorted("has_access of records that do not exist");
  }
  try {
    await new ModelImpl(env, def).checkAccess(ids, operation as "read" | "write" | "create" | "unlink");
    return true;
  } catch (e) {
    if (e instanceof OdooError && e.odooName === "odoo.exceptions.AccessError") return false;
    throw e;
  }
}, { apiModel: false, rawArgs: true, readonly: true });
