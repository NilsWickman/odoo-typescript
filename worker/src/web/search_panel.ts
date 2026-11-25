/**
 * The search panel of any model: `search_panel_select_range` (select="one") and `search_panel_select_multi_range`
 * (select="multi"), odoo/addons/web/models/models.py:1623-2173, with the helpers `_search_panel_field_image`,
 * `_search_panel_domain_image`, `_search_panel_global_counters`, `_search_panel_sanitized_parent_hierarchy` and
 * `_search_panel_selection_range`. The models with their own methods register them under their name (ir.module.module,
 * product.product, account.move.line), which `lookupMethod` prefers to these.
 */
import { NotPorted, OdooError, UserError } from "../errors";
import { and, cond, domainModelOf, optimizeBasic, parseDomain, TRUE } from "../orm/domain";
import { envTz } from "../orm/env";
import type { Domain, Environment, FieldDef } from "../orm/types";
import { formatList } from "../models/display_names";
import { translate } from "../models/util";
import { boolArg, envFor } from "./common";
import { formattedReadGroup } from "./read_group";
import { registerBaseMethod } from "./register";

type Key = number | string;
type Value = Record<string, unknown>;

/** models.py:30 SEARCH_PANEL_ERROR_MESSAGE. */
const TOO_MANY = "Too many items to display.";

/** Python truthiness of a keyword argument (`kwargs.get(...)`). */
function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  return boolArg(v);
}

function limitArg(v: unknown): number | null {
  if (v === undefined || v === null || v === false || v === 0) return null;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  throw new NotPorted(`search panel limit ${JSON.stringify(v)}`);
}

function domainArg(v: unknown): Domain {
  return v === undefined || v === null ? TRUE : parseDomain(v);
}

/**
 * Models whose `formatted_read_group`/`_read_group` or `_search_panel_domain_image` Python overrides the generic one
 * (account_account.py:475, account_bank_statement_line.py:443, project_tags.py:35, calendar_event.py:1160): refused
 * here rather than counted with the generic grouping.
 */
function refuseOverrides(env: Environment, model: string, fieldName: string, category = false): void {
  if (model === "account.account" && fieldName === "root_id" && !category) throw new NotPorted("account.account search panel on root_id (_search_panel_domain_image)");
  if (model === "account.bank.statement.line" || model === "calendar.event" || (model === "project.tags" && "project_id" in env.context)) {
    throw new NotPorted(`${model} search panel (its own formatted_read_group/_read_group)`);
  }
}

async function selectionLabels(env: Environment, model: string, fieldName: string): Promise<[string, string][]> {
  const desc = (await env.model(model).fieldsGet([fieldName], ["selection"]))[fieldName];
  const selection = desc?.["selection"];
  if (!Array.isArray(selection)) throw new NotPorted(`selection of ${model}.${fieldName}`);
  return selection.map((s) => {
    if (!Array.isArray(s) || typeof s[0] !== "string" || typeof s[1] !== "string") throw new NotPorted(`selection of ${model}.${fieldName}`);
    return [s[0], s[1]];
  });
}

/** models.py:1678-1726 `_search_panel_domain_image`. */
async function domainImage(env: Environment, model: string, field: FieldDef, domain: Domain, setCount: boolean, limit: number | null): Promise<Map<Key, Value>> {
  let idName: (value: unknown) => [Key, unknown];
  if (field.type === "many2one" || field.type === "many2many") {
    idName = (value) => {
      if (!Array.isArray(value) || typeof value[0] !== "number") throw new NotPorted(`search panel group value ${JSON.stringify(value)}`);
      return [value[0], value[1]];
    };
  } else {
    const labels = new Map(await selectionLabels(env, model, field.name));
    idName = (value) => {
      if (typeof value !== "string" || !labels.has(value)) throw new NotPorted(`search panel selection value ${JSON.stringify(value)} (KeyError)`);
      return [value, labels.get(value)];
    };
  }
  const groups = await formattedReadGroup(env.withContext({ ...env.context, read_group_expand: true }), model,
    and([domain, cond(field.name, "!=", false)]), [field.name], ["__count"], [], 0, limit, null);
  const image = new Map<Key, Value>();
  for (const group of groups) {
    const raw = group[field.name];
    // value hidden by a record rule or archived
    if (raw === false || raw === null || raw === undefined || (Array.isArray(raw) && raw.length === 0)) continue;
    const [id, displayName] = idName(raw);
    const values: Value = { id, display_name: displayName };
    if (setCount) values["__count"] = group["__count"];
    image.set(id, values);
  }
  return image;
}

interface ImageOptions {
  modelDomain: Domain;
  extraDomain: Domain;
  enableCounters: boolean;
  onlyCounters: boolean;
  limit: number | null;
  setLimit: boolean;
}

/** models.py:1623-1676 `_search_panel_field_image`. */
async function fieldImage(env: Environment, model: string, field: FieldDef, o: ImageOptions): Promise<Map<Key, Value>> {
  const noExtra = o.extraDomain.kind === "true";
  const countDomain = and([o.modelDomain, o.extraDomain]);
  if (o.onlyCounters) return domainImage(env, model, field, countDomain, true, null);
  const image = await domainImage(env, model, field, o.modelDomain, o.enableCounters && noExtra, o.setLimit ? o.limit : null);
  if (o.enableCounters && !noExtra) {
    const counts = await domainImage(env, model, field, countDomain, true, null);
    for (const [id, values] of image) values["__count"] = counts.get(id)?.["__count"] ?? 0;
  }
  return image;
}

/** models.py:1811-1857 `_search_panel_selection_range`. */
async function selectionRange(env: Environment, model: string, field: FieldDef, kwargs: Record<string, unknown>,
  modelDomain: Domain, extraDomain: Domain): Promise<Value[]> {
  const enableCounters = truthy(kwargs["enable_counters"]);
  const expand = truthy(kwargs["expand"]);
  let image = new Map<Key, Value>();
  if (enableCounters || !expand) {
    // `**kwargs` carries limit but not set_limit: the image is not limited
    image = await fieldImage(env, model, field, { modelDomain, extraDomain, enableCounters, onlyCounters: expand, limit: limitArg(kwargs["limit"]), setLimit: false });
  }
  if (!expand) return [...image.values()];
  return (await selectionLabels(env, model, field.name)).map(([value, label]) => {
    const values: Value = { id: value, display_name: label };
    if (enableCounters) values["__count"] = image.get(value)?.["__count"] ?? 0;
    return values;
  });
}

/** `Domain(kwargs['search_domain']).optimize(self)` and the category & filter domains (models.py:1915-1919, 2056-2060). */
async function panelDomains(env: Environment, model: string, kwargs: Record<string, unknown>): Promise<[Domain, Domain]> {
  const dmodel = domainModelOf(env.reg, env.reg.model(model), await envTz(env));
  const modelDomain = optimizeBasic(domainArg(kwargs["search_domain"]), dmodel);
  const extraDomain = optimizeBasic(and([domainArg(kwargs["category_domain"]), domainArg(kwargs["filter_domain"])]), dmodel);
  return [modelDomain, extraDomain];
}

/** `Comodel.search_read(domain, fields, limit=limit)` with the comodel's `_order`. */
async function comodelSearchRead(env: Environment, comodel: string, domain: Domain, fields: readonly string[], limit: number | null): Promise<Value[]> {
  if (comodel === "project.tags" && "project_id" in env.context) throw new NotPorted("project.tags.search_read with project_id in the context");
  const ids = await env.model(comodel).search(domain, limit === null ? {} : { limit });
  return ids.length ? env.model(comodel).read(ids, fields) : [];
}

function parentIdOf(record: Value, parentName: string): number | false {
  const v = record[parentName];
  return Array.isArray(v) && typeof v[0] === "number" ? v[0] : false;
}

/** models.py:1760-1808 `_search_panel_sanitized_parent_hierarchy`. */
function sanitizedParentHierarchy(records: Value[], parentName: string, ids: readonly number[]): Value[] {
  const allowed = new Map(records.map((r) => [Number(r["id"]), r]));
  const keep = new Map<number, boolean>();
  for (const id of ids) {
    let recordId: number | false = id;
    const chain: number[] = [];
    let included = true;
    while (included && recordId) {
      const known = keep.get(recordId);
      if (known !== undefined) {
        included = known;
        break;
      }
      const record = allowed.get(recordId);
      if (record) {
        if (!chain.includes(recordId)) chain.push(recordId);
        recordId = parentIdOf(record, parentName);
      } else {
        included = false;
      }
    }
    for (const r of chain) keep.set(r, included);
  }
  return records.filter((r) => keep.get(Number(r["id"])) === true);
}

/** models.py:1728-1758 `_search_panel_global_counters`: the local counts added to every ancestor's. */
function globalCounters(range: Map<number, Value>, parentName: string): void {
  const local = new Map<number, number>();
  const localOf = (id: number): number => {
    if (!local.has(id)) local.set(id, Number(range.get(id)?.["__count"] ?? 0));
    return local.get(id)!;
  };
  for (const id of range.keys()) {
    const count = localOf(id);
    if (!count) continue;
    let parentId = range.get(id)![parentName] as number | false;
    while (parentId) {
      const values = range.get(parentId);
      if (values === undefined) throw new NotPorted("search panel parent outside the range (KeyError)");
      localOf(parentId);
      values["__count"] = Number(values["__count"]) + count;
      parentId = values[parentName] as number | false;
    }
  }
}

function fieldFor(env: Environment, model: string, fieldName: unknown): FieldDef {
  if (typeof fieldName !== "string") throw new NotPorted(`search panel field ${JSON.stringify(fieldName)}`);
  const field = env.reg.model(model).fields.get(fieldName);
  // `self._fields[field_name]`: the KeyError's message is the name
  if (field === undefined) throw new OdooError("builtins.KeyError", fieldName);
  return field;
}

/** The `ttype` labels of ir.model.fields for the UserError of an unsupported type (models.py:1903-1910). */
async function ttypeLabels(env: Environment): Promise<Map<string, string>> {
  return new Map(await selectionLabels(env, "ir.model.fields", "ttype"));
}

/**
 * `search_panel_select_range('root_id')` of account.account (models.py:1859-1998 with account_account.py:475-491
 * `_search_panel_domain_image` and account_root.py): the roots are the first two characters of the accounts' codes
 * (`code`, the env company's root company's), string ids whose parents are their prefixes (`parent_id` of '40' is
 * '4'). `account.root._search` answers only `id in` and `id parent_of` (the sorted ids, every prefix of each), and
 * ignores the limit. Without counters, as the account search view asks; `hierarchize=False` (rows in the table's
 * order) and a comodel domain refuse.
 */
async function accountRootRange(env: Environment, kwargs: Record<string, unknown>, modelDomain: Domain, extraDomain: Domain): Promise<Value> {
  void extraDomain; // the image without counters reads the model domain only (models.py:1648-1652)
  if (truthy(kwargs["enable_counters"])) throw new NotPorted("account.account search panel on root_id with counters (generic read_group on root_id)");
  if (domainArg(kwargs["comodel_domain"]).kind !== "true") throw new NotPorted("account.account search panel on root_id with a comodel domain");
  const hierarchize = "hierarchize" in kwargs ? truthy(kwargs["hierarchize"]) : true;
  if (!hierarchize) throw new NotPorted("account.account search panel on root_id without hierarchy (rows in table order)");
  const limit = limitArg(kwargs["limit"]);
  if (truthy(kwargs["expand"])) {
    // `Comodel.search_read(Domain.TRUE)`: account_root.py:25-31 refuses any other domain
    throw new UserError(translate(env, "Filter on the Account or its Display Name instead"));
  }
  // account_account.py:475-491: `if domain.is_false(): return {}`, else the accounts' codes (no order, no limit:
  // set_limit is False with hierarchize)
  const roots = new Set<string>();
  if (modelDomain.kind !== "false") {
    const ids = await env.model("account.account").search(modelDomain);
    if (ids.length) {
      const company = await env.company();
      const root = (await env.cr.query<{ root: string }>("SELECT split_part(parent_path, '/', 1) AS root FROM res_company WHERE id = $1", [company])).rows[0]?.root ?? String(company);
      const fallback = (await env.cr.query("SELECT 1 FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id WHERE f.model = 'account.account' AND f.name = 'code_store' LIMIT 1")).rows.length;
      if (fallback) throw new NotPorted("account.account.code_store with an ir.default fallback (company-dependent to_sql)");
      const rows = (await env.cr.query<{ code: string | null }>("SELECT code_store->>$2 AS code FROM account_account WHERE id = ANY($1::int[])", [ids, root])).rows;
      for (const r of rows) if (r.code) roots.add(r.code.slice(0, 2));
    }
  }
  // `('id', 'parent_of', image ids)`: every prefix of each, sorted
  const all = new Set<string>();
  for (const r of roots) for (let i = 1; i <= r.length; i++) all.add(r.slice(0, i));
  const records = [...all].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (limit !== null && records.length === limit) return { error_msg: translate(env, TOO_MANY) };
  // every prefix is there, so `_search_panel_sanitized_parent_hierarchy` keeps them all
  const values = records.map((id) => ({ id, display_name: id, parent_id: id.length > 1 ? id.slice(0, -1) : false }));
  return { parent_field: "parent_id", values };
}

// models.py:1859-1998
registerBaseMethod("search_panel_select_range", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const field = fieldFor(env, model, "field_name" in kwargs ? kwargs["field_name"] : args[0]);
  const supported = ["many2one", "selection", "many2many"];
  if (!supported.includes(field.type)) {
    const types = await ttypeLabels(env);
    throw new UserError(translate(env, "Only types %(supported_types)s are supported for category (found type %(field_type)s)")
      .replace("%(supported_types)s", supported.map((t) => types.get(t) ?? t).join(", ")).replace("%(field_type)s", types.get(field.type) ?? field.type));
  }
  refuseOverrides(env, model, field.name, true);
  const [modelDomain, extraDomain] = await panelDomains(env, model, kwargs);
  if (model === "account.account" && field.name === "root_id") return accountRootRange(env, kwargs, modelDomain, extraDomain);
  if (field.type === "selection") {
    return { parent_field: false, values: await selectionRange(env, model, field, kwargs, modelDomain, extraDomain) };
  }
  const comodel = field.relation;
  if (comodel === null) throw new NotPorted(`search panel on ${model}.${field.name} without a comodel`);
  const coEnv = env.withContext({ ...env.context, hierarchical_naming: false });
  const coDef = env.reg.model(comodel);
  const fieldNames = ["display_name"];
  let hierarchize = "hierarchize" in kwargs ? truthy(kwargs["hierarchize"]) : true;
  let parentName: string | false = false;
  if (hierarchize && coDef.fields.has(coDef.parentName)) {
    parentName = coDef.parentName;
    fieldNames.push(parentName);
  } else {
    hierarchize = false;
  }
  let comodelDomain = domainArg(kwargs["comodel_domain"]);
  const enableCounters = truthy(kwargs["enable_counters"]);
  const expand = truthy(kwargs["expand"]);
  const limit = limitArg(kwargs["limit"]);
  // a Domain is falsy when it is TRUE (domains.py:362-370)
  const comodelTruthy = comodelDomain.kind !== "true";
  let image = new Map<Key, Value>();
  if (enableCounters || !expand) {
    image = await fieldImage(env, model, field, {
      modelDomain, extraDomain, enableCounters, onlyCounters: expand, limit, setLimit: limit !== null && !(expand || hierarchize || comodelTruthy),
    });
  }
  if (!(expand || hierarchize || comodelTruthy)) {
    const values = [...image.values()];
    if (limit !== null && values.length === limit) return { error_msg: translate(env, TOO_MANY) };
    return { parent_field: parentName, values };
  }
  const imageIds = [...image.keys()].map(Number);
  if (!expand) comodelDomain = and([comodelDomain, cond("id", hierarchize ? "parent_of" : "in", imageIds)]);
  let records = await comodelSearchRead(coEnv, comodel, comodelDomain, fieldNames, limit);
  if (hierarchize && parentName !== false) {
    const ids = expand ? records.map((r) => Number(r["id"])) : imageIds;
    records = sanitizedParentHierarchy(records, parentName, ids);
  }
  if (limit !== null && records.length === limit) return { error_msg: translate(env, TOO_MANY) };
  const range = new Map<number, Value>();
  for (const record of records) {
    const id = Number(record["id"]);
    const values: Value = { id, display_name: record["display_name"] };
    if (hierarchize && parentName !== false) values[parentName] = parentIdOf(record, parentName);
    if (enableCounters) values["__count"] = image.get(id)?.["__count"] ?? 0;
    range.set(id, values);
  }
  if (hierarchize && enableCounters && parentName !== false) globalCounters(range, parentName);
  return { parent_field: parentName, values: [...range.values()] };
}, { apiModel: true, readonly: true });

// models.py:2000-2173
registerBaseMethod("search_panel_select_multi_range", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const field = fieldFor(env, model, "field_name" in kwargs ? kwargs["field_name"] : args[0]);
  const supported = ["many2one", "many2many", "selection"];
  if (!supported.includes(field.type)) {
    // the list through `_()`'s format_list (tools/i18n.py) and the technical type (models.py:2049-2052)
    throw new UserError(translate(env, "Only types %(supported_types)s are supported for filter (found type %(field_type)s)")
      .replace("%(supported_types)s", formatList(env, supported)).replace("%(field_type)s", field.type));
  }
  refuseOverrides(env, model, field.name);
  const [modelDomain, extraDomainIn] = await panelDomains(env, model, kwargs);
  let extraDomain = extraDomainIn;
  if (field.type === "selection") {
    return { values: await selectionRange(env, model, field, kwargs, modelDomain, extraDomain) };
  }
  const comodel = field.relation;
  if (comodel === null) throw new NotPorted(`search panel on ${model}.${field.name} without a comodel`);
  const coEnv = env.withContext({ ...env.context, hierarchical_naming: false });
  const coDef = env.reg.model(comodel);
  const fieldNames = ["display_name"];
  const groupBy = kwargs["group_by"];
  const limit = limitArg(kwargs["limit"]);
  let groupIdName: ((value: unknown) => Promise<[unknown, unknown]>) | null = null;
  if (truthy(groupBy)) {
    if (typeof groupBy !== "string") throw new NotPorted(`search panel group_by ${JSON.stringify(groupBy)}`);
    const groupField = coDef.fields.get(groupBy);
    // `Comodel._fields[group_by]` (models.py:2075)
    if (groupField === undefined) throw new OdooError("builtins.KeyError", groupBy);
    fieldNames.push(groupBy);
    const notSet = (): string => translate(env, "Not Set");
    if (groupField.type === "many2one") {
      groupIdName = async (value) => (Array.isArray(value) && value.length ? [value[0], value[1]] : [false, notSet()]);
    } else if (groupField.type === "selection") {
      const labels = new Map<unknown, string>(await selectionLabels(coEnv, comodel, groupBy));
      labels.set(false, notSet());
      groupIdName = async (value) => {
        if (!labels.has(value)) throw new NotPorted(`search panel group value ${JSON.stringify(value)} (KeyError)`);
        return [value, labels.get(value)];
      };
    } else {
      if (!["char", "integer", "boolean"].includes(groupField.type)) throw new NotPorted(`search panel group_by on a ${groupField.type} field`);
      groupIdName = async (value) => (value !== false && value !== null && value !== "" && value !== 0 ? [value, value] : [false, notSet()]);
    }
  }
  let comodelDomain = domainArg(kwargs["comodel_domain"]);
  const comodelTruthy = comodelDomain.kind !== "true";
  const enableCounters = truthy(kwargs["enable_counters"]);
  const expand = truthy(kwargs["expand"]);
  const groupDomainRaw = kwargs["group_domain"];

  if (field.type === "many2many") {
    if (!expand) {
      const image = await domainImage(env, model, field, modelDomain, false, limit);
      comodelDomain = and([comodelDomain, cond("id", "in", [...image.keys()])]);
    }
    const records = await comodelSearchRead(coEnv, comodel, comodelDomain, fieldNames, limit);
    if (limit !== null && records.length === limit) return { error_msg: translate(env, TOO_MANY) };
    const range: Value[] = [];
    for (const record of records) {
      const id = Number(record["id"]);
      const values: Value = { id, display_name: record["display_name"] };
      let groupId: unknown = undefined;
      if (groupIdName !== null && typeof groupBy === "string") {
        const [gid, gname] = await groupIdName(record[groupBy]);
        groupId = gid;
        values["group_id"] = gid;
        values["group_name"] = gname;
      }
      if (enableCounters) {
        let countDomain = and([modelDomain, cond(field.name, "in", id), extraDomain]);
        if (groupIdName !== null && truthy(groupDomainRaw)) {
          // `group_domain.get(json.dumps(group_id), true)`: json.dumps of an int or False
          if (typeof groupDomainRaw !== "object" || groupDomainRaw === null || Array.isArray(groupDomainRaw)) throw new NotPorted("search panel group_domain that is not a dict");
          const key = groupId === false ? "false" : typeof groupId === "number" ? String(groupId) : null;
          if (key === null) throw new NotPorted(`search panel group_domain key of ${JSON.stringify(groupId)}`);
          countDomain = and([countDomain, domainArg((groupDomainRaw as Record<string, unknown>)[key])]);
        }
        values["__count"] = await env.model(model).searchCount(countDomain);
      }
      range.push(values);
    }
    return { values: range };
  }

  // many2one
  let image = new Map<Key, Value>();
  if (enableCounters || !expand) {
    if (groupDomainRaw !== undefined && groupDomainRaw !== null && !Array.isArray(groupDomainRaw)) {
      throw new NotPorted("search panel group_domain dict on a many2one filter (Domain(dict))");
    }
    extraDomain = and([extraDomain, domainArg(groupDomainRaw)]);
    image = await fieldImage(env, model, field, {
      modelDomain, extraDomain, enableCounters, onlyCounters: expand, limit, setLimit: limit !== null && !(expand || truthy(groupBy) || comodelTruthy),
    });
  }
  if (!(expand || truthy(groupBy) || comodelTruthy)) {
    const values = [...image.values()];
    if (limit !== null && values.length === limit) return { error_msg: translate(env, TOO_MANY) };
    return { values };
  }
  if (!expand) comodelDomain = and([comodelDomain, cond("id", "in", [...image.keys()])]);
  const records = await comodelSearchRead(coEnv, comodel, comodelDomain, fieldNames, limit);
  if (limit !== null && records.length === limit) return { error_msg: translate(env, TOO_MANY) };
  const range: Value[] = [];
  for (const record of records) {
    const id = Number(record["id"]);
    const values: Value = { id, display_name: record["display_name"] };
    if (groupIdName !== null && typeof groupBy === "string") {
      const [gid, gname] = await groupIdName(record[groupBy]);
      values["group_id"] = gid;
      values["group_name"] = gname;
    }
    if (enableCounters) values["__count"] = image.get(id)?.["__count"] ?? 0;
    range.push(values);
  }
  return { values: range };
}, { apiModel: true, readonly: true });
