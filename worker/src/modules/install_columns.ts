/**
 * The values of a column the install adds (or makes required) on the rows a table already has, written by the port:
 * `Field._init_column_data` (odoo/orm/fields.py:1299-1345), D23 path B part B3 (compiler/VAGB.md, D24). The build
 * records each call without its values (gen/install_capture.py `init_column_data`: placeholder `@@init_column <n>@@`),
 * since what Odoo wrote there depends on the build's rows, not this database's:
 *   - a constant default: `UPDATE <table> SET <col> = <value> WHERE <col> IS NULL` at the call's place (before the
 *     NOT NULL the init phase may add after it); a boolean False of a field that is not required writes nothing;
 *   - a computed field (no default value, or no default): its records with NULL marked to compute, computed by the
 *     port's recompute (`env.add_to_compute`, flushed by Odoo inside `init_models`) once the module's registry is
 *     loaded, at the end of the module's init phase, as the superuser (Odoo's flush writes write_uid 1).
 * A callable default is the port's own default of the field, evaluated on this database (`callableDefault`). An
 * `init_storage` function, or a required computed column on a table with rows refuses (NotPorted).
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { fieldDefault, RecomputeQueue } from "../orm/recompute";
import { generatedDefault } from "../orm/defaults_gen";
import { toWriteFormat } from "../web/defaults";
import { coComputed } from "../orm/create";
import { trackedFields } from "../mail/tracking";

export interface InitColumn {
  readonly phase: string;
  readonly model: string;
  readonly table: string;
  readonly field: string;
  readonly type: string;
  readonly required: boolean;
  readonly init_storage: boolean;
  /** The init_storage function's result, when it can only be a constant (gen/install_capture.py) */
  readonly init_storage_result?: { readonly value: null | boolean | "default" };
  readonly compute: boolean;
  readonly default: null | { readonly value: unknown } | { readonly callable: true };
}

const ident = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** The callable defaults of fields the registry has not loaded yet, written once it has (`computeInitColumns`). */
const PENDING_DEFAULTS = new WeakMap<object, InitColumn[]>();
/** The `SET NOT NULL` of a required column whose default is put off (`postponeNotNull`), run right after it. */
const POSTPONED_NOT_NULL = new WeakMap<object, string[]>();

/**
 * A replayed `ALTER TABLE <t> ALTER COLUMN <c> SET NOT NULL` of a column whose callable default waits for the registry
 * (purchase_requisition_stock's required purchase.requisition.picking_type_id: Odoo writes the default, then the
 * constraint): kept until `computeInitColumns` has written the default. Whether `sql` was put off.
 */
export function postponeNotNull(cr: object, sql: string): boolean {
  const m = /^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" SET NOT NULL$/.exec(sql.trim());
  if (!m || !PENDING_DEFAULTS.get(cr)?.some((c) => c.table === m[1] && c.field === m[2])) return false;
  const list = POSTPONED_NOT_NULL.get(cr) ?? [];
  list.push(sql);
  POSTPONED_NOT_NULL.set(cr, list);
  return true;
}

/** The first data write of the phase after a callable default was put off (`noteDataWrite`), which makes it refuse. */
const WRITTEN_SINCE = new WeakMap<object, string>();

/**
 * A statement of the init phase that writes data (an init column's UPDATE, a replayed DML statement outside the ir_
 * tables, a translation import), while a callable default waits for the registry: Odoo evaluated that default before it,
 * the port would after it, so the default refuses at `computeInitColumns` (the value could differ).
 */
export function noteDataWrite(cr: object, what: string): void {
  if (PENDING_DEFAULTS.get(cr)?.length && !WRITTEN_SINCE.has(cr)) WRITTEN_SINCE.set(cr, what);
}

/** The computed columns of a phase whose records wait for the module's registry. */
const PENDING = new WeakMap<object, { model: string; field: string; ids: number[] }[]>();

async function hasRows(env: Environment, table: string): Promise<boolean> {
  return (await env.cr.query(`SELECT 1 FROM ${ident(table)} LIMIT 1`)).rows.length > 0;
}

/** fields.py:1299-1345 at the call's place in the init phase. */
export async function initColumnData(env: Environment, c: InitColumn): Promise<void> {
  if (!(c.init_storage || c.default || c.compute)) return;
  if (!(await hasRows(env, c.table))) return;
  if (c.init_storage && !c.init_storage_result) throw new NotPorted(`install: ${c.model}.${c.field} initialized by an init_storage function on existing rows`);
  // :1310-1314 `to_compute`: the init_storage function's result, else 'default'
  let toCompute: unknown = c.init_storage_result ? c.init_storage_result.value : "default";
  let value: unknown = null;
  if (c.default && "callable" in c.default && !env.reg.models.get(c.model)?.fields.has(c.field)) {
    // a field the module adds to a model loaded before it (l10n_cn's account.move.line
    // l10n_cn_output_vat_offset_account_id) is in the port's registry only once it is loaded again at the end of the
    // init phase: its default is evaluated then, before the phase's computations, with nothing between the two that
    // reads the column; a required one's NOT NULL waits for it (`postponeNotNull`). The same for a model the phase's
    // registry does not have yet
    const list = PENDING_DEFAULTS.get(env.cr) ?? [];
    list.push(c);
    PENDING_DEFAULTS.set(env.cr, list);
    return;
  }
  if (c.default) {
    value = "callable" in c.default ? await callableDefault(env, c) : c.default.value;
    if (value !== null && toCompute === "default") toCompute = false; // :1319 a default: the field is not recomputed
  }
  if (value === false && c.type === "boolean" && !c.required) value = null;
  if (value !== null && value !== undefined) {
    const json = typeof value === "object";
    noteDataWrite(env.cr, `init column ${c.model}.${c.field}`);
    await env.cr.query(`UPDATE ${ident(c.table)} SET ${ident(c.field)} = $1${json ? "::jsonb" : ""} WHERE ${ident(c.field)} IS NULL`,
      [json ? JSON.stringify(value) : value]);
  }
  if (toCompute && c.compute) {
    if (c.required) throw new NotPorted(`install: the required computed column ${c.model}.${c.field} on existing rows`);
    const ids = (await env.cr.query<{ id: number }>(`SELECT id FROM ${ident(c.table)} WHERE ${ident(c.field)} IS NULL`)).rows.map((r) => r.id);
    if (!ids.length) return;
    const list = PENDING.get(env.cr) ?? [];
    list.push({ model: c.model, field: c.field, ids });
    PENDING.set(env.cr, list);
  }
}

/**
 * fields.py:1315-1321 `value = self.default(model)` for a callable default, in init_models' environment (loading.py:188,
 * registry.py:812: the superuser, context {'module': <module>}): the port's own default of the field (a hand-ported or
 * compiled `default=`, gen/write_defaults.py's patterns), never ir.default (:1314 "ir.default not being ready"), as
 * `convert_to_write` then `convert_to_column_insert` give it. purchase_requisition_stock's picking_type_id (the incoming
 * type of the superuser's company), l10n_cn's `self.env.company.l10n_cn_output_vat_offset_account_id`. A default the
 * port does not have, or of a type other than a plain column, refuses.
 */
async function callableDefault(env: Environment, c: InitColumn): Promise<unknown> {
  const where = `install: ${c.model}.${c.field}'s callable default on existing rows (_init_column_data)`;
  const field = env.reg.model(c.model).fields.get(c.field);
  if (!field || field.translate || field.companyDependent || !PLAIN_COLUMN.has(field.type)) throw new NotPorted(`${where}: a ${field?.type ?? "missing"} field`);
  // :1319 `value is not None` decides whether a computed field is recomputed, which the port's False cannot tell
  if (c.compute) throw new NotPorted(`${where}: a computed field`);
  const module = c.phase.startsWith("init:") ? c.phase.slice(5) : null;
  const initEnv = env.withUser(1).sudo().withContext(module ? { module } : {});
  const fn = fieldDefault(c.model, c.field);
  const raw = fn ? await fn(initEnv) : await generatedDefault(initEnv, c.model, c.field);
  if (raw === undefined) throw new NotPorted(`${where}: the port has no default for it`);
  // models.py convert_to_write: a record its id, an empty value False (convert_to_column_insert: NULL, nothing written)
  const v = await toWriteFormat(initEnv, c.model, field, raw);
  if (v === false && field.type !== "boolean") return null;
  if (field.type === "many2one" && typeof v !== "number") throw new NotPorted(`${where}: a ${typeof v} for a many2one`);
  return v;
}

/** The column types whose default `callableDefault` writes as it is. */
const PLAIN_COLUMN = new Set(["many2one", "char", "text", "selection", "integer", "float", "monetary", "boolean", "date", "datetime"]);

/** The computations `initColumnData` marked, once the module's models are in the registry (end of its init phase). */
export async function computeInitColumns(env: Environment): Promise<void> {
  const defaults = PENDING_DEFAULTS.get(env.cr);
  if (defaults?.length) {
    PENDING_DEFAULTS.delete(env.cr);
    const since = WRITTEN_SINCE.get(env.cr);
    WRITTEN_SINCE.delete(env.cr);
    if (since) throw new NotPorted(`install: ${defaults[0]!.model}.${defaults[0]!.field}'s callable default put off past a data write of its phase (${since})`);
    for (const c of defaults) {
      if (!env.reg.model(c.model).fields.has(c.field)) throw new NotPorted(`install: ${c.model}.${c.field} not in the registry after its module's init phase`);
      await initColumnData(env, c);
    }
    const notNull = POSTPONED_NOT_NULL.get(env.cr) ?? [];
    POSTPONED_NOT_NULL.delete(env.cr);
    for (const sql of notNull) await env.cr.query(sql);
  }
  const list = PENDING.get(env.cr);
  if (!list?.length) return;
  PENDING.delete(env.cr);
  const su = env.withUser(1).sudo();
  const queue = new RecomputeQueue(su);
  for (const p of list) {
    if (await preparesTracking(su, p.model, p.field)) queue.markNullCached(p.model, p.field, p.ids);
    else queue.markUncached(p.model, p.field, p.ids);
    queue.add(p.model, p.field, p.ids);
  }
  await queue.run();
}

/**
 * mail_thread.py:502-506: a mail.thread model's `_compute_field_value` first prepares the tracking of the stored fields
 * the method computes (`_track_prepare`, mail_track_mixin.py:76-96), which reads the tracked ones: the records' rows
 * are fetched, and the new column is cached with the NULL it has (fields.py `_insert_cache`), so the compute's
 * assignment is compared with that (`_filter_not_equal`): the raw None, so a False writes nothing where the field's
 * `convert_to_cache` gives None (Selection, Many2one, Char), and a Boolean's False or a number's 0 is written (l10n_eu_
 * account_vies's tracked res.partner.vies_valid: 349 cached before, 349 dirty after, results/k2core/trace_vies.log,
 * 2026-11-14). Measured on Odoo
 * (results/k2core/trace_cols.py, 2026-11-13): l10n_kr's tracked account.move.l10n_kr_issuance_type, 86 moves cached
 * before the compute, 0 dirty after (the port wrote all 86, vagb_chart_kr); partner_title's untracked title_id, 0
 * cached, 13 of 351 dirty (vagb_oca_rows). Without tracking the rows stay uncached unless the compute reads a column
 * of the record that is not in the cache (a fetch of its row), which the port does not model.
 */
async function preparesTracking(env: Environment, model: string, field: string): Promise<boolean> {
  const def = env.reg.model(model);
  if (!def.isMailThread || env.context["tracking_disable"] || env.context["mail_notrack"]) return false;
  const tracked = new Set((await trackedFields(env, model)).map((f) => f.name));
  return coComputed(def, def.fields.get(field)!).some((n) => tracked.has(n) && def.fields.get(n)?.store);
}
