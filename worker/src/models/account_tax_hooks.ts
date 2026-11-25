/**
 * The tax engine's extension points (account/models/account_tax.py) as dispatch points: the methods modules override
 * to put their own fields into the base lines, the tax lines and the tax lines' grouping keys (account_fleet's
 * `vehicle_id`, hr_expense's `expense_id`, l10n_in's `l10n_in_hsn_code`).
 *
 * - `_prepare_base_line_for_taxes_computation(record, **kwargs)` (:1572-1677) and
 *   `_prepare_tax_line_for_taxes_computation(record, **kwargs)` (:1679-1720): the hand port's base line is the JS
 *   engine's (account_tax_engine.js, the mirror of the same method), with data objects where Odoo has records. Its
 *   Odoo dict here (`odooBaseLine`, `odooTaxLine`) has the records as PrivateRecords and the values Odoo loads from the
 *   record; a compiled override gets it from its super(). The keys an override adds are carried along (`extras`);
 *   an override that changes or removes one of the dict's keys refuses (the engine computes with its own values).
 * - `_prepare_base_line_grouping_key(base_line)` (:2317-2332), `_prepare_base_line_tax_repartition_grouping_key(...)`
 *   (:2334-2365 with l10n_us_account account_tax.py:88-98) and `_prepare_tax_line_repartition_grouping_key(tax_line)`
 *   (:2367-2385): the hand implementations give Odoo's dicts; `taxLineKey` compares them as `_prepare_tax_lines`
 *   compares its frozendicts (:3079-3172), the keys an override adds included.
 *
 * Without a compiled override every dict is the hand port's own and the keys are the ones the hand port compared
 * before (src/models/account_move_create.ts syncInvoice).
 */
import { NotPorted } from "../errors";
import { isPyFloat } from "../pyexpr/values";
import { idsModel, PrivateKwargs, PrivateNewRecords, PrivateRecords, privateNormal } from "../orm/private_hooks";
import { DbRec, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import type { BaseLine } from "./account_tax_engine";
import * as priv from "../orm/dispatch_gen";

export type Row = Record<string, unknown>;

// ------------------------------------------------------------------------------------------------------------ values

/** A recordset in a hook's dict: the hand port's PrivateRecords, or ids with their model (compiled code's, toJs). */
function idsOf(x: unknown, what: string): number[] {
  if (x instanceof PrivateRecords) return [...x.ids];
  if (Array.isArray(x) && idsModel(x) !== null && x.every((id) => typeof id === "number")) return [...(x as number[])];
  throw new NotPorted(`${what}: ${JSON.stringify(privateNormal(x))} where a recordset is expected`);
}

/** `records.id`: the id of one record, False for none (several raise in Odoo, `ensure_one`). */
function idOf(x: unknown, what: string): number | false {
  const ids = idsOf(x, what);
  if (ids.length > 1) throw new NotPorted(`${what}: .id of ${ids.length} records (Expected singleton)`);
  return ids[0] ?? false;
}

/** `d[k]` of a dict: a missing key is a KeyError in Odoo, refused here. */
function at(d: Row, k: string, what: string): unknown {
  if (!(k in d)) throw new NotPorted(`${what}: no key '${k}' (KeyError)`);
  return d[k];
}

function dictOf(x: unknown, what: string): Row {
  if (x === null || typeof x !== "object" || Array.isArray(x) || Object.getPrototypeOf(x) !== Object.prototype) {
    throw new NotPorted(`${what}: ${typeof x} where a dict is expected`);
  }
  return x as Row;
}

/** A value as Python's `==` compares it: records as their ids, floats as numbers, booleans as the ints they equal. */
function pyEq(x: unknown): unknown {
  if (x instanceof PrivateRecords) return { records: x.model, ids: [...x.ids] };
  if (x instanceof PrivateNewRecords) return { records: x.model, ids: x.recs.map((r) => r.id ?? -1) };
  if (isPyFloat(x)) return x.float;
  if (typeof x === "boolean") return x ? 1 : 0;
  if (Array.isArray(x)) {
    const m = idsModel(x);
    return m !== null ? { records: m, ids: [...x] } : x.map(pyEq);
  }
  if (x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
    return Object.fromEntries(Object.entries(x as Row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, pyEq(v)]));
  }
  return x === undefined ? null : x;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(pyEq(a)) === JSON.stringify(pyEq(b));

/** A value from compiled code in the hand port's form: its recordsets as PrivateRecords again, its floats numbers. */
function handForm(x: unknown): unknown {
  if (isPyFloat(x)) return x.float;
  if (Array.isArray(x)) {
    const m = idsModel(x);
    if (m !== null) {
      if (x.some((id) => typeof id !== "number" || id < 0)) throw new NotPorted(`a recordset of new ${m} records in a tax engine dict`);
      return new PrivateRecords(m, x as number[]);
    }
    return x.map(handForm);
  }
  if (x !== null && typeof x === "object" && Object.getPrototypeOf(x) === Object.prototype) {
    return Object.fromEntries(Object.entries(x as Row).map(([k, v]) => [k, handForm(v)]));
  }
  return x;
}

const recs = (model: string, id: unknown): PrivateRecords => new PrivateRecords(model, typeof id === "number" && id ? [id] : []);

/** The record a base or tax line is prepared from (`record`): stored, new, or None. */
export type LineRecord = PrivateRecords | PrivateNewRecords | null;

/** `record` of a line: a stored record by its id, a new one as its Rec (the records of a compute or an onchange). */
export function lineRecord(model: string, rec: Rec): LineRecord {
  return rec.id !== null ? new PrivateRecords(model, [rec.id]) : new PrivateNewRecords(model, [rec]);
}

// ------------------------------------------------------------------------------------------------------- base lines

/** The values of a base line that Odoo loads from its record and the hand port's engine leaves out (product_id: {}). */
export interface LoadedValues {
  readonly product_id: number | false;
  readonly product_uom_id: number | false;
  readonly partner_id: number | false;
  readonly account_id: number | false;
  readonly analytic_distribution: unknown;
  readonly is_refund: boolean;
}

/**
 * account_tax.py:1572-1677 `_prepare_base_line_for_taxes_computation(record, **kwargs)` as the dict Odoo gives: the
 * engine's base line (the mirror of the method, account_tax_engine.js:767-824) with its data objects as records, and
 * the values the engine does not load (`loaded`).
 */
export function odooBaseLine(base: BaseLine, record: LineRecord, kwargs: Row, loaded: LoadedValues): Row {
  const b = base as unknown as Row & { tax_ids: readonly { id: number }[]; currency_id: { id?: number } | null };
  // :1539-1569 `_get_base_line_field_value_from_record`: a keyword argument first (`extra_values[field] or fallback`)
  const given = (field: string, model: string, own: number | false): PrivateRecords =>
    kwargs[field] instanceof PrivateRecords ? kwargs[field] as PrivateRecords : field in kwargs ? recs(model, false) : recs(model, own);
  return {
    ...kwargs,
    record,
    id: b["id"] ?? 0,
    product_id: given("product_id", "product.product", loaded.product_id),
    product_uom_id: given("product_uom_id", "uom.uom", loaded.product_uom_id),
    tax_ids: new PrivateRecords("account.tax", b.tax_ids.map((t) => t.id)),
    price_unit: b["price_unit"],
    quantity: b["quantity"],
    discount: b["discount"],
    currency_id: recs("res.currency", b.currency_id?.id),
    special_mode: b["special_mode"] || false,
    document_tax_mode: b["document_tax_mode"] || false,
    special_type: b["special_type"] || false,
    rate: b["rate"],
    filter_tax_function: null,
    sign: b["sign"],
    is_refund: "is_refund" in kwargs ? kwargs["is_refund"] || false : loaded.is_refund,
    partner_id: given("partner_id", "res.partner", loaded.partner_id),
    account_id: given("account_id", "account.account", loaded.account_id),
    analytic_distribution: "analytic_distribution" in kwargs ? kwargs["analytic_distribution"] || null : loaded.analytic_distribution ?? null,
    computation_key: b["computation_key"] ?? null,
    manual_total_excluded_currency: b["manual_total_excluded_currency"] ?? null,
    manual_total_excluded: b["manual_total_excluded"] ?? null,
    manual_tax_amounts: b["manual_tax_amounts"] ?? null,
  };
}

/** The base line's dict through the dispatch, and the keys a compiled override added to it. */
export interface PreparedLine {
  /** the dict, the added keys included (recordsets as PrivateRecords) */
  readonly line: Row;
  /** the keys a compiled override added, by name */
  readonly extras: Row;
}

/** A compiled super() into the hand implementation: the record and keyword arguments it was given, refused otherwise. */
function sameCall(what: string, args: readonly unknown[], record: LineRecord, kwargs: Row): void {
  const kw = args.length === 2 && args[1] instanceof PrivateKwargs ? args[1].values : args.length === 1 ? {} : null;
  if (kw === null || !same(args[0] ?? null, record) || !same(kw, kwargs)) {
    throw new NotPorted(`${what}: a compiled super() with another record or other keyword arguments than the hand port's`);
  }
}

/** The override's dict against the hand port's: the keys it added, and a refusal for a changed or removed one. */
function addedKeys(what: string, own: Row, out: unknown): PreparedLine {
  const d = dictOf(out, what);
  for (const [k, v] of Object.entries(own)) {
    if (!(k in d)) throw new NotPorted(`${what}: a compiled override removing '${k}'`);
    if (!same(v, d[k])) throw new NotPorted(`${what}: a compiled override changing '${k}' (the hand port's engine computes with its own)`);
  }
  const extras: Row = {};
  for (const [k, v] of Object.entries(d)) if (!(k in own)) extras[k] = handForm(v);
  return { line: { ...own, ...extras }, extras };
}

/**
 * `self.env['account.tax']._prepare_base_line_for_taxes_computation(record, **kwargs)` through the dispatch, `own` the
 * hand port's dict of it (odooBaseLine).
 */
export async function prepareBaseLine(env: Environment, record: LineRecord, kwargs: Row, own: Row): Promise<PreparedLine> {
  const what = "account.tax._prepare_base_line_for_taxes_computation";
  const args: unknown[] = Object.keys(kwargs).length ? [record, new PrivateKwargs(kwargs)] : [record];
  const out = await priv.account_tax._prepare_base_line_for_taxes_computation.call(env, [], args, async (_e, _i, a) => {
    sameCall(what, a, record, kwargs);
    return { ...own };
  });
  return addedKeys(what, own, out);
}

/**
 * A base line the hand port computes totals from (orders, invoice summaries, a product's tax string): a compiled
 * override of `_prepare_base_line_for_taxes_computation` runs as in Odoo where a template has one; the keys it adds
 * are not read there, one changing the engine's values refuses.
 */
export async function checkBaseLine(env: Environment, base: BaseLine,
  call: () => Promise<{ readonly record: LineRecord; readonly kwargs: Row; readonly loaded: LoadedValues }>): Promise<void> {
  if (!(await priv.account_tax._prepare_base_line_for_taxes_computation.overridden(env))) return;
  const { record, kwargs, loaded } = await call();
  await prepareBaseLine(env, record, kwargs, odooBaseLine(base, record, kwargs, loaded));
}

/** The DbRec of a stored line (orders read by SQL). */
export function storedLine(env: Environment, model: string, id: number): Rec {
  return new DbRec(env, env.reg.model(model), id);
}

/** The values `loaded` from a record (`_get_base_line_field_value_from_record` without kwargs): its fields if it has them. */
export async function loadedOf(rec: Rec | null, kwargs: Row, isRefund: boolean): Promise<LoadedValues> {
  const rel = async (field: string): Promise<number | false> => {
    const given = kwargs[field];
    if (given !== undefined) return given instanceof PrivateRecords ? idOf(given, field) : typeof given === "number" && given ? given : false;
    if (!rec || !rec.def.fields.has(field)) return false;
    const r = await rec.rel(field);
    if (r && r.origin === null) throw new NotPorted(`a base line's ${field} that is a new record`);
    return r ? r.origin! : false;
  };
  const analytic = rec && rec.def.fields.has("analytic_distribution") ? await rec.get("analytic_distribution") : null;
  return {
    product_id: await rel("product_id"), product_uom_id: await rel("product_uom_id"), partner_id: await rel("partner_id"),
    account_id: await rel("account_id"), analytic_distribution: analytic || null, is_refund: isRefund,
  };
}

// -------------------------------------------------------------------------------------------------------- tax lines

/**
 * account_tax.py:1679-1720 `_prepare_tax_line_for_taxes_computation(record, **kwargs)` of an existing tax line (a
 * journal item, `row` its columns), as Odoo's dict, through the dispatch: the full dict an override gives (only its
 * grouping key is read, `_prepare_tax_lines` :3157-3164).
 */
export async function prepareTaxLine(env: Environment, row: Row, taxIds: readonly number[], tags: readonly number[], kwargs: Row): Promise<Row> {
  const what = "account.tax._prepare_tax_line_for_taxes_computation";
  const record = new PrivateRecords("account.move.line", [Number(row["id"])]);
  const own: Row = {
    ...kwargs,
    record,
    id: Number(row["id"]),
    tax_repartition_line_id: recs("account.tax.repartition.line", row["tax_repartition_line_id"]),
    group_tax_id: recs("account.tax", row["group_tax_id"]),
    tax_ids: new PrivateRecords("account.tax", [...taxIds]),
    tax_tag_ids: new PrivateRecords("account.account.tag", [...tags]),
    currency_id: recs("res.currency", row["currency_id"] ?? row["company_currency_id"]),
    partner_id: recs("res.partner", row["partner_id"]),
    account_id: recs("account.account", row["account_id"]),
    analytic_distribution: row["analytic_distribution"] ?? null,
    sign: kwargs["sign"] ?? 1,
    amount_currency: Number(row["amount_currency"] ?? 0),
    balance: Number(row["balance"] ?? 0),
  };
  const out = await priv.account_tax._prepare_tax_line_for_taxes_computation.call(env, [], [record, new PrivateKwargs(kwargs)], async (_e, _i, a) => {
    sameCall(what, a, record, kwargs);
    return { ...own };
  });
  return handForm(dictOf(out, what)) as Row;
}

// ---------------------------------------------------------------------------------------------------- grouping keys

/** account_tax.py:2317-2332 `_prepare_base_line_grouping_key(base_line)`. */
export async function baseLineGroupingKeyHand(_env: Environment, baseLine: unknown): Promise<Row> {
  const what = "account.tax._prepare_base_line_grouping_key";
  const b = dictOf(baseLine, what);
  return {
    partner_id: idOf(at(b, "partner_id", what), what),
    currency_id: idOf(at(b, "currency_id", what), what),
    analytic_distribution: at(b, "analytic_distribution", what),
    account_id: idOf(at(b, "account_id", what), what),
    tax_ids: [[6, 0, idsOf(at(b, "tax_ids", what), what)]],
  };
}

/**
 * account_tax.py:2334-2365 `_prepare_base_line_tax_repartition_grouping_key(base_line, base_line_grouping_key,
 * tax_data, tax_rep_data)`, with l10n_us_account's definition (account_tax.py:88-98, in the baseline): the zero
 * tax line of a US tax is kept for the US tax report.
 */
export async function baseLineTaxRepGroupingKeyHand(env: Environment, baseLine: unknown, baseKey: unknown, taxData: unknown, taxRepData: unknown): Promise<Row> {
  const what = "account.tax._prepare_base_line_tax_repartition_grouping_key";
  const b = dictOf(baseLine, what), k = dictOf(baseKey, what), td = dictOf(taxData, what), rd = dictOf(taxRepData, what);
  const tax = idOf(at(td, "tax", what), what), rep = idOf(at(rd, "tax_rep", what), what);
  const us = env.reg.model("account.tax").fields.has("l10n_us_exempt_parent_tax_id");
  const row = (await env.cr.query<{ analytic: boolean | null; closing: boolean | null; us: boolean | null }>(
    `SELECT t.analytic, r.use_in_tax_closing AS closing, ${us ? `(c.code = 'US' AND (co.chart_template = 'us' OR t.l10n_us_exempt_parent_tax_id IS NOT NULL
            OR t.l10n_us_nontaxable_parent_tax_id IS NOT NULL))` : "false"} AS us
       FROM account_tax t LEFT JOIN res_country c ON c.id = t.country_id LEFT JOIN res_company co ON co.id = t.company_id,
            account_tax_repartition_line r
      WHERE t.id = $1 AND r.id = $2`, [tax || 0, rep || 0])).rows[0];
  if (!row) throw new NotPorted(`${what}: tax ${String(tax)} or repartition line ${String(rep)} not found`);
  const account = idOf(at(rd, "account", what), what);
  return {
    ...k,
    tax_repartition_line_id: rep,
    partner_id: idOf(at(b, "partner_id", what), what),
    currency_id: idOf(at(b, "currency_id", what), what),
    group_tax_id: idOf(at(td, "group", what), what),
    analytic_distribution: row.analytic || !row.closing ? at(k, "analytic_distribution", what) : false,
    account_id: account || at(k, "account_id", what),
    tax_ids: [[6, 0, idsOf(at(rd, "taxes", what), what)]],
    tax_tag_ids: [[6, 0, idsOf(at(rd, "tax_tags", what), what)]],
    __keep_zero_line: Boolean(row.us),
  };
}

/** account_tax.py:2367-2385 `_prepare_tax_line_repartition_grouping_key(tax_line)`. */
export async function taxLineRepGroupingKeyHand(_env: Environment, taxLine: unknown): Promise<Row> {
  const what = "account.tax._prepare_tax_line_repartition_grouping_key";
  const t = dictOf(taxLine, what);
  return {
    tax_repartition_line_id: idOf(at(t, "tax_repartition_line_id", what), what),
    partner_id: idOf(at(t, "partner_id", what), what),
    currency_id: idOf(at(t, "currency_id", what), what),
    group_tax_id: idOf(at(t, "group_tax_id", what), what),
    analytic_distribution: at(t, "analytic_distribution", what),
    account_id: idOf(at(t, "account_id", what), what),
    tax_ids: [[6, 0, idsOf(at(t, "tax_ids", what), what)]],
    tax_tag_ids: [[6, 0, idsOf(at(t, "tax_tag_ids", what), what)]],
  };
}

/** The keys of account's tax line grouping key (`_prepare_tax_line_repartition_grouping_key`, :2378-2385). */
const KEY_FIELDS = ["tax_repartition_line_id", "partner_id", "currency_id", "group_tax_id", "analytic_distribution", "account_id", "tax_ids", "tax_tag_ids"];

/** A grouping key as `_prepare_tax_lines` uses it. */
export interface TaxLineKey {
  /** equal for equal frozendicts without the `__` keys (:3123-3133) */
  readonly key: string;
  readonly rep: number | null;
  readonly account: number | null;
  readonly partner: number | null;
  readonly currency: number | null;
  readonly group: number | null;
  /** the analytic distribution in the key, null for none or an empty one */
  readonly analytic: unknown;
  readonly taxIds: number[];
  readonly tags: number[];
  /** the keys a compiled override added (account_fleet's `vehicle_id`), the values a created tax line takes */
  readonly extras: Row;
  /** `__keep_zero_line` (l10n_us_account) */
  readonly keep: boolean;
}

/** The ids of `[Command.set(ids)]`. */
function setIds(x: unknown, what: string): number[] {
  const c = Array.isArray(x) && x.length === 1 && Array.isArray(x[0]) ? (x[0] as unknown[]) : null;
  if (!c || c.length !== 3 || c[0] !== 6 || !Array.isArray(c[2]) || !(c[2] as unknown[]).every((id) => typeof id === "number")) {
    throw new NotPorted(`${what}: ${JSON.stringify(privateNormal(x))} where [Command.set(ids)] is expected`);
  }
  return [...(c[2] as number[])];
}

const keyId = (x: unknown, k: string, what: string): number | null => {
  if (x === false || x === null || x === undefined) return null;
  if (typeof x !== "number") throw new NotPorted(`${what}: '${k}' ${JSON.stringify(privateNormal(x))} where an id is expected`);
  return x;
};

/**
 * A tax line's grouping key (`_prepare_tax_line_repartition_grouping_key`) or the one a base line's tax repartition
 * gives (`_prepare_base_line_tax_repartition_grouping_key`), compared as the hand port compared them before
 * (taxes and tags as sets, an empty analytic distribution as none), the keys an override added as Python compares
 * them.
 */
export function taxLineKey(d0: unknown, what: string): TaxLineKey {
  const d = dictOf(d0, what);
  for (const k of KEY_FIELDS) at(d, k, what);
  const rep = keyId(d["tax_repartition_line_id"], "tax_repartition_line_id", what), account = keyId(d["account_id"], "account_id", what);
  const partner = keyId(d["partner_id"], "partner_id", what), currency = keyId(d["currency_id"], "currency_id", what);
  const group = keyId(d["group_tax_id"], "group_tax_id", what);
  const a = d["analytic_distribution"];
  const analytic = a && typeof a === "object" && Object.keys(a).length ? a : null;
  const taxIds = setIds(d["tax_ids"], what), tags = setIds(d["tax_tag_ids"], what);
  const extras: Row = {};
  for (const [k, v] of Object.entries(d)) if (!KEY_FIELDS.includes(k) && !k.startsWith("__")) extras[k] = v;
  const names = Object.keys(extras).sort();
  const key = JSON.stringify([rep, partner, currency, group, analytic === null ? null : pyEq(analytic), account,
    [...taxIds].sort((x, y) => x - y), [...tags].sort((x, y) => x - y), ...(names.length ? [names.map((k) => [k, pyEq(extras[k])])] : [])]);
  return { key, rep, account, partner, currency, group, analytic, taxIds, tags, extras, keep: Boolean(d["__keep_zero_line"]) };
}

/**
 * account_move.py:3348-3363 `_sync_tax_lines`: the fields of a base line whose change syncs the tax lines are the keys
 * of `_prepare_base_line_grouping_key` on an empty base line; the ones a compiled override adds there, for the
 * database's template (none without one).
 */
export async function addedGroupingFields(env: Environment): Promise<string[]> {
  if (!(await priv.account_tax._prepare_base_line_for_taxes_computation.overridden(env)) && !(await priv.account_tax._prepare_base_line_grouping_key.overridden(env))) return [];
  const none: LoadedValues = { product_id: false, product_uom_id: false, partner_id: false, account_id: false, analytic_distribution: null, is_refund: false };
  const empty = { id: 0, tax_ids: [], price_unit: 0, quantity: 0, discount: 0, currency_id: null, sign: 1, special_mode: null, document_tax_mode: null,
    special_type: null, rate: 1, computation_key: null, manual_total_excluded_currency: null, manual_total_excluded: null, manual_tax_amounts: null } as unknown as BaseLine;
  const { line } = await prepareBaseLine(env, null, {}, odooBaseLine(empty, null, {}, none));
  const key = dictOf(await priv.account_tax._prepare_base_line_grouping_key.invoke(env, line), "account.tax._prepare_base_line_grouping_key");
  const own = ["partner_id", "currency_id", "analytic_distribution", "account_id", "tax_ids"];
  return Object.keys(key).filter((k) => !own.includes(k));
}

/**
 * The tax engine's dispatch points where the hand port has no grouping of its own (an early payment discount's
 * write-off lines, account_move.py:5240-5390): refused where a template has a compiled override of one of them.
 */
export async function refuseTaxEngineOverride(env: Environment, where: string): Promise<void> {
  for (const h of [priv.account_tax._prepare_base_line_for_taxes_computation, priv.account_tax._prepare_base_line_grouping_key,
    priv.account_tax._prepare_base_line_tax_repartition_grouping_key, priv.account_tax._prepare_tax_line_for_taxes_computation,
    priv.account_tax._prepare_tax_line_repartition_grouping_key]) {
    if (await h.overridden(env)) throw new NotPorted(`${where} with a compiled override of account.tax.${h.name}`);
  }
}
