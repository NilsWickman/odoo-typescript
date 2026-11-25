/**
 * Plain ORM read methods over call_kw for the models C1 reaches:
 *  - `read(fields=None, load='_classic_read')` (odoo/odoo/orm/models.py:2798),
 *  - `search_read(domain, fields, offset, limit, order, **read_kwargs)` (models.py:5232, src/models/res_lang.ts),
 *  - `res.users.has_group(group_ext_id)` (odoo/odoo/addons/base/models/res_users.py:1195-1212).
 * Registered per model (not '*'): only models whose Python classes in poc_erp do not override read/search_read/
 * search_fetch/_read_format, or whose override is guarded below (crm.lead.search_fetch, crm_lead.py:825).
 */
import { AccessError, NotPorted, OdooError } from "../errors";
import { CUSTOM_MODEL } from "../http/custom_model";
import { hasOwnMethod, lookupMethod, registerMethod } from "../http/methods";
import { parseDomain } from "../orm/domain";
import genCorpus from "../../gen/out/orm_methods.json" with { type: "json" };
import genErp from "../../gen/out/poc_erp/orm_methods.json" with { type: "json" };
import { searchRead } from "../models/res_lang";
import type { Environment } from "../orm/types";
import { envFor, intArg, optInt, optStr } from "./common";
import { userHasGroup } from "./groups";

/** models.py:2798 `read(self, fields=None, load='_classic_read')`. */
export { read as readMethod };
async function read(env: Environment, model: string, ids: number[], args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> {
  for (const k of Object.keys(kwargs)) if (k !== "fields" && k !== "load") throw new NotPorted(`read keyword ${k}`);
  const rawFields = "fields" in kwargs ? kwargs["fields"] : args[0];
  let fields: string[] = [];
  if (rawFields === undefined || rawFields === null || rawFields === false) fields = [];
  else if (Array.isArray(rawFields) && rawFields.every((f): f is string => typeof f === "string")) fields = rawFields;
  else throw new NotPorted(`read fields=${JSON.stringify(rawFields)}`);
  const rawLoad = "load" in kwargs ? kwargs["load"] : args.length > 1 ? args[1] : "_classic_read";
  const load = rawLoad === "_classic_read" ? "_classic_read" : rawLoad === "" || rawLoad === null || rawLoad === false ? "" : null;
  if (load === null) throw new NotPorted(`read load=${JSON.stringify(rawLoad)}`);
  return env.model(model).read(ids, fields, load);
}

for (const model of ["res.currency", "crm.stage", "crm.team", "res.country", "crm.lead", "res.users",
  // no read/_read_format/fetch override in their classes or mixins (mail, portal, rating, project, sale_pdf_quote_builder)
  "discuss.call.history", "discuss.channel", "project.task", "quotation.document", "res.partner",
  // the API corpus models whose classes and inherited mixins in poc_erp define none of read/_read_format/fetch/
  // search_fetch/_fetch_query (scanned from the installed modules' class bodies)
  "account.analytic.line", "account.bank.statement.line", "account.fiscal.position", "account.invoice.report",
  "account.payment.term", "calendar.alarm", "calendar.calendar", "calendar.event.type", "crm.activity.report",
  "crm.iap.lead.mining.request", "crm.lost.reason", "crm.tag", "discuss.category", "ir.module.module",
  "mail.activity.plan", "mail.activity.type", "mail.canned.response", "payment.provider", "product.attribute",
  "product.supplierinfo", "project.role", "project.tags", "purchase.report", "rating.rating", "report.project.task.user",
  "res.city", "res.config.settings", "res.country.group", "res.country.state", "res.partner.category",
  "res.partner.industry", "res.role", "sale.report", "spreadsheet.dashboard", "spreadsheet.dashboard.group",
  "spreadsheet.dashboard.share", "stock.move.line", "stock.picking.type", "stock.warehouse",
  // the same scan attributing each class to its own `_name` (else its `_inherit`): no override either
  "sale.order.template", "sale.order", "res.company", "project.project", "product.template", "product.product", "product.category",
  "mail.call.artifact", /* no read override, base ir_attachment.py:817 is `_search` */ "ir.attachment",
  /* calendar_event.py:974-998 `_fetch_query`: the `fetchFilter` hook */ "calendar.event"]) {
  registerMethod(model, "read", async (env0, ids, args, kwargs0, name) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return read(env, name, ids ?? [], args, kwargs);
  }, { apiModel: false, readonly: true });
}

for (const model of ["crm.stage", "crm.lead", "mail.activity.type", "calendar.filters", "calendar.user", "calendar.event", "account.journal",
  // no search_read/search_fetch/_search/read override in the classes of project.project (project, sale_project, ...)
  "project.project",
  // nor in those of project.task (project, project_todo, sale_project, project_stock, ...)
  "project.task", "project.task.type",
  // none either in sale, sale_management, purchase, purchase_stock
  "sale.order", "sale.order.template", "purchase.order",
  // mail.template (mail, account, phone_validation; mail.render.mixin, template.reset.mixin): no override either
  "mail.template",
  // base ir_attachment.py:817 `_search` is the `search` hook of src/models/ir_attachment_access.ts
  "ir.attachment"]) {
  registerMethod(model, "search_read", async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    // crm.lead's search_fetch override (ordering on my_activity_date_deadline) is the model's searchFetch hook
    return searchRead(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
}

registerMethod("res.users", "has_group", async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const group = "group_ext_id" in kwargs ? kwargs["group_ext_id"] : args[0];
  if (typeof group !== "string") throw new OdooError("builtins.TypeError", "has_group() missing 1 required positional argument: 'group_ext_id'");
  const users = ids ?? [];
  // :1203 ensure_one
  if (users.length !== 1) throw new OdooError("builtins.ValueError", `Expected singleton: res.users(${users.join(", ")}${users.length === 1 ? "," : ""})`);
  const uid = users[0] as number;
  // :1204-1207
  if (!(env.su || uid === env.uid || await userHasGroup(env, "base.group_user"))) {
    throw new AccessError("You can ony call user.has_group() with your current user.");
  }
  // :1209 self._has_group: membership of the record's user; :1210-1211 group_no_one only in debug
  return userHasGroup(uid === env.uid ? env : env.withUser(uid), group);
}, { apiModel: false, readonly: true });

/** models.py `search(domain, offset=0, limit=None, order=None)`: the ids, through RPC. */
export async function search(env: Environment, model: string, args: unknown[], kwargs: Record<string, unknown>): Promise<number[]> {
  const known = ["domain", "offset", "limit", "order"];
  for (const k of Object.keys(kwargs)) if (!known.includes(k)) throw new NotPorted(`search keyword ${k}`);
  if (args.length > 4) throw new OdooError("builtins.TypeError", `search() takes from 2 to 5 positional arguments but ${args.length + 1} were given`);
  const pick = (name: string, pos: number): unknown => (name in kwargs ? kwargs[name] : args[pos]);
  const raw = pick("domain", 0);
  if (raw === undefined) throw new OdooError("builtins.TypeError", "BaseModel.search() missing 1 required positional argument: 'domain'");
  return env.model(model).search(parseDomain(raw === null || raw === false ? [] : raw),
    { offset: intArg(pick("offset", 1), "offset", 0), limit: optInt(pick("limit", 2), "limit"), order: optStr(pick("order", 3), "order") });
}

/** models.py `search_count(domain, limit=None)`. */
export async function searchCount(env: Environment, model: string, args: unknown[], kwargs: Record<string, unknown>): Promise<number> {
  for (const k of Object.keys(kwargs)) if (k !== "domain" && k !== "limit") throw new NotPorted(`search_count keyword ${k}`);
  if (args.length > 2) throw new OdooError("builtins.TypeError", `search_count() takes from 2 to 3 positional arguments but ${args.length + 1} were given`);
  const raw = "domain" in kwargs ? kwargs["domain"] : args[0];
  if (raw === undefined) throw new OdooError("builtins.TypeError", "BaseModel.search_count() missing 1 required positional argument: 'domain'");
  return env.model(model).searchCount(parseDomain(raw === null || raw === false ? [] : raw), optInt("limit" in kwargs ? kwargs["limit"] : args[1], "limit"));
}

/**
 * The models whose `read`, `search`, `search_count`, `search_read` and every helper they use are Odoo's own
 * (gen/orm_methods.py over poc_corpus and poc_erp: no module overrides them, nor the access checks). A model present
 * in both templates keeps the methods that are generic in both. The hand-checked registrations above take precedence.
 */
function genericMethods(): Map<string, Set<string>> {
  const lists = [genCorpus.models, genErp.models] as Record<string, string[]>[];
  const out = new Map<string, Set<string>>();
  for (const name of new Set(lists.flatMap((l) => Object.keys(l)))) {
    const present = lists.map((l) => l[name]).filter((m): m is string[] => Array.isArray(m));
    const allowed = new Set(present[0]!.filter((x) => present.every((m) => m.includes(x))));
    if (allowed.size) out.set(name, allowed);
  }
  return out;
}

for (const [model, methods] of genericMethods()) {
  const own = (method: string): boolean => methods.has(method) && lookupMethod(model, method) === null;
  const envOf = (env0: Environment, kwargs0: Record<string, unknown>): ReturnType<typeof envFor> => envFor(env0, kwargs0);
  if (own("read")) registerMethod(model, "read", async (env0, ids, args, kwargs0, name) => {
    const { env, kwargs } = envOf(env0, kwargs0);
    return read(env, name, ids ?? [], args, kwargs);
  }, { apiModel: false, readonly: true });
  if (own("search_read")) registerMethod(model, "search_read", async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envOf(env0, kwargs0);
    return searchRead(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
  if (own("search")) registerMethod(model, "search", async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envOf(env0, kwargs0);
    return search(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
  if (own("search_count")) registerMethod(model, "search_count", async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envOf(env0, kwargs0);
    return searchCount(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
}

/**
 * Round 7: the read methods of models whose classes override a helper the port has as a hook (so the generic method
 * answers as Odoo), registered where gen/orm_methods.py leaves them out:
 *  - crm.lead `search_fetch` (crm_lead.py:825-855, the searchFetch hook of src/models/crm_lead.ts): `search`; and
 *    `search_count`, which goes through `_search` only (models.py `search_count`), not `search_fetch`;
 *  - ir.attachment `_search` (base ir_attachment.py:817, the searchOverride of src/models/ir_attachment_access.ts);
 *  - res.company `_fetch_field` (models_cached.py, the cached model's field fetch: values as read): `search_read`,
 *    as its `read` above;
 *  - account.account `_search` and `_order_to_sql` (account_account.py:802-830, :972-997) are Odoo's own unless the
 *    context asks for the inactive parents or a preferred order, which refuse.
 */
function registerGeneric(model: string, methods: readonly ("read" | "search" | "search_count" | "search_read")[],
  guard: (env: Environment) => void = () => undefined): void {
  for (const method of methods) {
    if (hasOwnMethod(model, method)) continue; // a model-specific registration (src/models) wins
    registerMethod(model, method, async (env0, ids, args, kwargs0, name) => {
      const { env, kwargs } = envFor(env0, kwargs0);
      guard(env);
      if (method === "read") return read(env, name, ids ?? [], args, kwargs);
      if (method === "search") return search(env, name, args, kwargs);
      if (method === "search_count") return searchCount(env, name, args, kwargs);
      return searchRead(env, name, args, kwargs);
    }, { apiModel: method !== "read", readonly: true });
  }
}

// a custom model (B4, ir_model.state manual): BaseModel's read methods (http/methods.ts CUSTOM_MODEL)
registerGeneric(CUSTOM_MODEL, ["read", "search", "search_count", "search_read"]);
registerGeneric("crm.lead", ["search", "search_count"]);
registerGeneric("ir.attachment", ["search", "search_count"]);
registerGeneric("res.company", ["search_read"]);
// account.tax `_search` (account_tax.py:486-501) only rewrites the domain: the searchDomain hook of
// src/models/account_move_create.ts, applied by searchQuery itself
registerGeneric("account.tax", ["search", "search_count", "search_read"]);
registerGeneric("account.account", ["read", "search", "search_count", "search_read"], (env) => {
  for (const k of ["include_inactive_account_parents", "preferred_account_type", "preferred_account_ids", "sort_by_non_trade"]) {
    if (env.context[k]) throw new NotPorted(`account.account search with ${k} in the context (account_account.py _search/_order_to_sql)`);
  }
});

/**
 * mail.activity `_search` (mail_activity.py:416-497): Odoo's plain `_search` (with the record rule on `res_access_read`,
 * src/models/mail_activity_access.ts) for the superuser, a false domain, a search of the user's own activities
 * (`condition_values(user_id) == (uid,)`) and a search restricted to at most MAX_COMODELS_FOR_DOMAIN (5,
 * mail_message.py:31) document models. A domain on `date_done` (archived activities included), on `id` (records
 * filtered one by one) and the batched filtering of the other searches refuse.
 */
async function activitySearchGuard(env: Environment, rawDomain: unknown): Promise<void> {
  const { conditionValues } = await import("../models/mail_activity_access");
  const { isFalse } = await import("../orm/domain");
  const domain = parseDomain(rawDomain === null || rawDomain === undefined || rawDomain === false ? [] : rawDomain);
  if (JSON.stringify(rawDomain ?? []).includes('"date_done"')) throw new NotPorted("mail.activity search on date_done (active_test dropped)");
  const def = env.reg.model("mail.activity");
  if (env.su || isFalse(domain)) return;
  const users = await conditionValues(env, def, "user_id", domain);
  if (users !== null && users.length === 1 && users[0] === env.uid) return;
  if (await conditionValues(env, def, "id", domain) !== null) throw new NotPorted("mail.activity search by ids (records filtered by access one by one)");
  const models = await conditionValues(env, def, "res_model", domain);
  if (models !== null && models.length > 0 && models.length <= 5) return;
  throw new NotPorted("mail.activity search over all document models (batched access filtering, mail_activity.py:470-497)");
}

for (const method of ["search", "search_count", "search_read"] as const) {
  registerMethod("mail.activity", method, async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    await activitySearchGuard(env, "domain" in kwargs ? kwargs["domain"] : args[0]);
    if (method === "search") return search(env, name, args, kwargs);
    if (method === "search_count") return searchCount(env, name, args, kwargs);
    return searchRead(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
}

/**
 * mail.message `_search` (mail_message.py:434-471): Odoo's plain `_search` (the access rule on `res_access_read`,
 * src/models/mail_activity_access.ts) for the superuser, a false domain, and a search without limit or restricted to at
 * most MAX_COMODELS_FOR_DOMAIN (5) document models; otherwise the batched filtering (`messageSearchBatched`), whose
 * ids become the searched domain (`self.browse(result[offset:limit])._as_query(ordered)`: the fetch keeps their order,
 * which the same order on them reproduces). Returns null for the plain path.
 */
async function messageSearchIds(env: Environment, rawDomain: unknown, offset: unknown, limit: unknown, order: string | null): Promise<number[] | null> {
  const { conditionValues, messageSearchBatched } = await import("../models/mail_activity_access");
  const { isFalse } = await import("../orm/domain");
  const domain = parseDomain(rawDomain === null || rawDomain === undefined || rawDomain === false ? [] : rawDomain);
  if (env.su || isFalse(domain)) return null;
  if (env.context["_generating_sql_for_fields"]) throw new NotPorted("mail.message search generating SQL for fields");
  const models = await conditionValues(env, env.reg.model("mail.message"), "model", domain);
  if (limit === undefined || limit === null || limit === false || (models !== null && models.length > 0 && models.length <= 5)) return null;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) throw new NotPorted(`mail.message search with limit ${JSON.stringify(limit)}`);
  const off = offset === undefined || offset === null || offset === false ? 0 : offset;
  if (typeof off !== "number" || !Number.isInteger(off) || off < 0) throw new NotPorted(`mail.message search with offset ${JSON.stringify(offset)}`);
  if (order !== null && typeof order !== "string") throw new NotPorted("mail.message search with a non-string order");
  if (limit === 0) return null; // `limit=0` is falsy: no batching (`0 < len(...)`, `while len(result) < 0`) -- plain path
  return messageSearchBatched(env, domain, off, limit, order);
}

const MESSAGE_SEARCH_ARGS: Readonly<Record<"search" | "search_count" | "search_read", readonly string[]>> = {
  search: ["domain", "offset", "limit", "order"],
  search_read: ["domain", "fields", "offset", "limit", "order"],
  search_count: ["domain", "limit"],
};

for (const method of ["search", "search_count", "search_read"] as const) {
  registerMethod("mail.message", method, async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    const names = MESSAGE_SEARCH_ARGS[method];
    const pick = (k: string): unknown => (k in kwargs ? kwargs[k] : args[names.indexOf(k)]);
    if (args.length > names.length) throw new NotPorted(`mail.message.${method} with ${args.length} positional arguments`);
    // search and search_read go through search_fetch, which passes `order or self._order` (models.py search_fetch):
    // the batched branch is then always ordered; search_count passes no order
    const rawOrder = method === "search_count" ? null : pick("order");
    const order = method === "search_count" ? null : (typeof rawOrder === "string" && rawOrder ? rawOrder : env.reg.model("mail.message").order);
    const ids = await messageSearchIds(env, pick("domain"), method === "search_count" ? 0 : pick("offset"), pick("limit"), order);
    if (ids === null) {
      if (method === "search") return search(env, name, args, kwargs);
      if (method === "search_count") return searchCount(env, name, args, kwargs);
      return searchRead(env, name, args, kwargs);
    }
    if (method === "search_count") return ids.length;
    const rest: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(kwargs)) if (!names.includes(k)) rest[k] = v;
    const domain = [["id", "in", ids]];
    if (method === "search") return search(env, name, [domain], { ...rest, order });
    return searchRead(env, name, [domain], { ...rest, ...(pick("fields") !== undefined ? { fields: pick("fields") } : {}), order });
  }, { apiModel: true, readonly: true });
}

/**
 * base ir_filters.py:99-120 `get_filters(model, action_id=None, embedded_action_id=None, embedded_parent_res_id=None)`:
 * the user's and the shared filters of the model for the action (`_get_action_domain` :89-97), with the user's context.
 */
registerMethod("ir.filters", "get_filters", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const names = ["model", "action_id", "embedded_action_id", "embedded_parent_res_id"];
  for (const k of Object.keys(kwargs)) if (!names.includes(k)) throw new OdooError("builtins.TypeError", `IrFilters.get_filters() got an unexpected keyword argument '${k}'`);
  if (args.length > 4) throw new OdooError("builtins.TypeError", `IrFilters.get_filters() takes from 2 to 5 positional arguments but ${args.length + 1} were given`);
  const pick = (i: number): unknown => (names[i]! in kwargs ? kwargs[names[i]!] : args[i]);
  const model = pick(0);
  if (model === undefined) throw new OdooError("builtins.TypeError", "IrFilters.get_filters() missing 1 required positional argument: 'model'");
  const action = pick(1), embedded = pick(2), parentRes = pick(3);
  for (const v of [action, embedded, parentRes]) {
    if (v !== undefined && v !== null && v !== false && typeof v !== "number") throw new NotPorted(`ir.filters.get_filters with ${JSON.stringify(v)}`);
  }
  const domain = ["&", "&", "&", "&",
    ["action_id", "in", [action || false, false]],
    ["embedded_action_id", "=", embedded || false],
    ["embedded_parent_res_id", "=", embedded && parentRes ? parentRes : false],
    ["model_id", "=", model], ["user_ids", "in", [env.uid, false]]];
  // `self.env['res.users'].context_get()`: the user's lang and tz over the request context
  const { userInfo } = await import("../orm/env");
  const user = await userInfo(env);
  const ctx = { ...env.context, ...(user.lang ? { lang: user.lang } : {}), ...(user.tz ? { tz: user.tz } : {}) };
  return searchRead(env.withContext(ctx), "ir.filters", [domain, ["name", "is_default", "domain", "context", "user_ids", "sort", "embedded_action_id", "embedded_parent_res_id"]], {});
}, { apiModel: true, readonly: true });
