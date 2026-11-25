/**
 * Per-model Python behaviour plugs into the generic ORM here (PORTING_odoo.md sections 2, 7, 9): computed
 * non-stored fields, `_compute_display_name`, `_search_display_name`, `name_search` overrides and the search
 * functions of searchable computed fields. The models stream (src/models/) registers; the ORM stream (src/orm/)
 * consults. Only the ORM stream edits this file's types; registrations happen in the models' own modules, which
 * src/index.ts imports for their side effects.
 */
import type { Domain, Environment, FieldDef, SearchOptions } from "./types";
import type { Sql, Table } from "./sql";
import { keyed, type KeyKind } from "./keys";

/** Computes field values for ids; absent ids get the field's empty value. */
export type ComputeFn = (env: Environment, ids: readonly number[]) => Promise<Map<number, unknown>>;

/** Turns a condition on a searchable computed field into a domain on stored fields (`search=` function). */
export type SearchFn = (env: Environment, operator: string, value: unknown) => Promise<Domain | null>;
// null stands for Python's NotImplemented: the ORM retries with the inverse operator and the '='/'!=' compatibility
// path (domains.py:1078-1110, src/orm/sql.ts fieldSearchMethod)

/** Callable `selection=` of a Selection field (fields_selection.py:208): the `(value, label)` pairs for the env. */
export type SelectionFn = (env: Environment) => Promise<readonly [string, string][]>;

/**
 * Write-path side effects of a model's Python overrides (`create`/`write`/`unlink` super() chains), run by the
 * ORM write core (src/orm/write*.ts) in registration order. `mail.thread` (src/mail/) registers tracking,
 * followers and creation messages here (mail_thread.py `create` :271, `write` :334, `_track_finalize` / `_message_track`).
 * `before` sees the values about to be written; `after` runs once the rows are flushed, with the old values of the
 * fields that were written (Odoo's `_track_prepare` snapshot) so trackers can compare.
 */
export interface WriteHooks {
  readonly beforeCreate?: (env: Environment, valsList: Record<string, unknown>[]) => Promise<void>;
  readonly afterCreate?: (env: Environment, ids: readonly number[], valsList: readonly Record<string, unknown>[]) => Promise<void>;
  readonly beforeWrite?: (env: Environment, ids: readonly number[], vals: Record<string, unknown>) => Promise<void>;
  readonly afterWrite?: (env: Environment, ids: readonly number[], vals: Readonly<Record<string, unknown>>,
    old: ReadonlyMap<number, Readonly<Record<string, unknown>>>) => Promise<void>;
  readonly beforeUnlink?: (env: Environment, ids: readonly number[]) => Promise<void>;
  readonly afterUnlink?: (env: Environment, ids: readonly number[]) => Promise<void>;
}

/** Python `@api.onchange(fields)` methods: mutate `record` (the onchange snapshot's values) for the env. */
export type OnchangeFn = (env: Environment, record: Record<string, unknown>) => Promise<{ warning?: { title: string; message: string; type?: string } } | void>;

/** A stored computed field's compute body: ids -> values, run by the recompute queue. */
export type StoredComputeFn = ComputeFn;

/** `@api.constrains(fields)`: raise ValidationError for invalid ids. */
export type ConstraintFn = (env: Environment, ids: readonly number[]) => Promise<void>;

/** `default_get` / field defaults computed in Python (lambda defaults, `_default_*` methods), by field. */
export type DefaultFn = (env: Environment) => Promise<unknown>;

export interface ModelHooks {
  readonly write?: readonly WriteHooks[];
  /** `@api.onchange` methods by the fields that trigger them (one entry per method, in MRO order). */
  readonly onchange?: readonly { readonly fields: readonly string[]; readonly fn: OnchangeFn }[];
  /** Stored computed fields' bodies (depends come from gen/out/models.json). */
  readonly storedCompute?: Readonly<Record<string, StoredComputeFn>>;
  readonly defaults?: Readonly<Record<string, DefaultFn>>;

  /** `compute_sql=` of non-stored computed fields (fields.py:1365 `Field.to_sql`): the SQL value on `table`,
   *  used for grouping, ordering, aggregates and domains (e.g. crm.lead.company_currency, crm_lead.py:280). */
  readonly computeSql?: Readonly<Record<string, (table: Table) => Promise<Sql>>>;
  /** Non-stored computed fields the views request (PORTING_odoo.md section 7), by field name. */
  readonly computed?: Readonly<Record<string, ComputeFn>>;
  readonly search?: Readonly<Record<string, SearchFn>>;
  /** Selection fields whose keys come from a method (`res.partner.lang` = `_lang_get`, res_partner.py:304). */
  readonly selection?: Readonly<Record<string, SelectionFn>>;
  readonly descriptionDomain?: Readonly<Record<string, (env: Environment) => Promise<unknown>>>;
  /** `_fetch_query` override: the values of a stored field as fetched by a user that is not superuser. */
  readonly fetchFilter?: (env: Environment, field: FieldDef, values: Map<number, unknown>) => Promise<Map<number, unknown>>;
  /** `_compute_display_name` override: ids -> display name. */
  readonly displayName?: (env: Environment, ids: readonly number[]) => Promise<Map<number, string>>;
  /** The override's empty name is Python False (it comes from an empty `_rec_name` via `super()`), not ''. */
  readonly displayNameFalse?: boolean;
  /** `_search_display_name` override: operator and value -> domain, or null for Python's NotImplemented (domains.py:1075-1089:
   *  the positive operator is tried and negated, src/orm/sql.ts fieldSearchMethod; fleet_vehicle_model.py:73-77). */
  readonly searchDisplayName?: (env: Environment, operator: string, value: unknown) => Promise<Domain | null>;
  /** `name_search` override (rare: res.users, res.country). */
  readonly nameSearch?: (env: Environment, name: string, domain: Domain, operator: string, limit: number | null) => Promise<[number, string | false][]>;
  /** `search_fetch` override with the search options (crm.lead ordering on my_activity_date_deadline,
   *  crm_lead.py:825); `next` is super() with the given domain and options. */
  readonly searchFetch?: (env: Environment, domain: Domain, opts: SearchOptions, next: (d: Domain, o: SearchOptions) => Promise<number[]>) => Promise<number[]>;
  /** `_make_access_error_message(operation, domain)` override (mail.message, mail_message.py:733-745): the error of
   *  a record access check for the forbidden ids, or null for the base message. */
  readonly accessErrorMessage?: (env: Environment, ids: readonly number[], operation: string, domain: Domain) => Promise<Error | null>;
  /** `_search` Python-side branches (mail.message, mail.activity: PORTING_odoo.md section 9.6). */
  readonly searchOverride?: (env: Environment, domain: Domain, next: (d: Domain) => Promise<number[]>) => Promise<number[]>;
  /** A `_search` override that only rewrites the domain before `super()._search` (account.tax, account_tax.py:486-501):
   *  applied by `searchQuery` itself, so every search of the model (search, read_group, name_search, an `any`
   *  subquery through the comodel's `_search`) sees it, as in Odoo.
   *  It may read the database (ir.module.module on the site, src/modules/apps_visible.ts). */
  readonly searchDomain?: (env: Environment, domain: Domain) => Domain | Promise<Domain>;
}

const HOOKS = new Map<string, ModelHooks>();

/** Wrap every function of `hooks` under its registry key (src/orm/keys.ts): maps by field, lists by position. */
function keyedHooks(model: string, hooks: ModelHooks): ModelHooks {
  const map = <T extends (...args: never[]) => unknown>(kind: KeyKind, m: Readonly<Record<string, T>> | undefined): Record<string, T> | undefined =>
    m === undefined ? undefined : Object.fromEntries(Object.entries(m).map(([k, fn]) => [k, keyed(kind, model, k, fn)]));
  const one = <T extends (...args: never[]) => unknown>(kind: KeyKind, fn: T | undefined): T | undefined =>
    fn === undefined ? undefined : keyed(kind, model, "*", fn);
  const prev = HOOKS.get(model);
  const writeBase = prev?.write?.length ?? 0;
  const onchangeBase = prev?.onchange?.length ?? 0;
  const out: Record<string, unknown> = { ...hooks };
  const set = (k: string, v: unknown): void => { if (v !== undefined) out[k] = v; };
  set("computed", map("hooks.computed", hooks.computed));
  set("search", map("hooks.search", hooks.search));
  set("selection", map("hooks.selection", hooks.selection));
  set("storedCompute", map("hooks.storedCompute", hooks.storedCompute));
  set("defaults", map("hooks.defaults", hooks.defaults));
  set("computeSql", map("hooks.computeSql", hooks.computeSql));
  set("descriptionDomain", map("hooks.descriptionDomain", hooks.descriptionDomain));
  set("fetchFilter", one("hooks.fetchFilter", hooks.fetchFilter));
  set("displayName", one("hooks.displayName", hooks.displayName));
  set("searchDisplayName", one("hooks.searchDisplayName", hooks.searchDisplayName));
  set("nameSearch", one("hooks.nameSearch", hooks.nameSearch));
  set("searchFetch", one("hooks.searchFetch", hooks.searchFetch));
  set("searchOverride", one("hooks.searchOverride", hooks.searchOverride));
  if (hooks.write) set("write", hooks.write.map((w, i) => Object.fromEntries(Object.entries(w).map(([k, fn]) =>
    [k, keyed("hooks.write", model, `#${writeBase + i}.${k}`, fn as (...args: never[]) => unknown)]))));
  if (hooks.onchange) set("onchange", hooks.onchange.map((o, i) => ({ ...o, fn: keyed("hooks.onchange", model, `#${onchangeBase + i}`, o.fn) })));
  return out as ModelHooks;
}

export function registerHooks(model: string, raw: ModelHooks): void {
  const hooks = keyedHooks(model, raw);
  const prev = HOOKS.get(model);
  HOOKS.set(model, prev === undefined ? hooks : {
    ...prev, ...hooks,
    computed: { ...prev.computed, ...hooks.computed },
    search: { ...prev.search, ...hooks.search },
    selection: { ...prev.selection, ...hooks.selection },
    descriptionDomain: { ...prev.descriptionDomain, ...hooks.descriptionDomain },
    computeSql: { ...prev.computeSql, ...hooks.computeSql },
    storedCompute: { ...prev.storedCompute, ...hooks.storedCompute },
    defaults: { ...prev.defaults, ...hooks.defaults },
    write: [...(prev.write ?? []), ...(hooks.write ?? [])],
    onchange: [...(prev.onchange ?? []), ...(hooks.onchange ?? [])],
  });
}

export function hooksOf(model: string): ModelHooks {
  return HOOKS.get(model) ?? {};
}
