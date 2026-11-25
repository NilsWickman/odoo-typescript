/**
 * Field tracking of mail.thread models (odoo/addons/mail/models/mail_track_mixin.py, mail_thread.py :544-717).
 *
 * Odoo snapshots the tracked fields of the written records before `write` (`_track_prepare(self._fields)`,
 * mail_track_mixin.py:29,76), discards the records created in the transaction (`_track_discard`, :107, from
 * mail_thread.py create), and at precommit compares the snapshot with the end values (`_track_finalize` :133,
 * `_mail_track` :366) and logs one tracking message per changed record (`_track_log` mail_thread.py:628, no subtype for
 * the ported models, so `_message_log_batch`). The port keeps the snapshot per request cursor and finalizes when the
 * outermost write of the model returns (WRITE_HOOKS.md: the documented difference to a precommit).
 */
import type { Cursor } from '../db';
import { NotPorted } from '../errors';
import { createdSinceCommit } from '../orm/created';
import { hooksOf } from '../orm/hooks';
import type { Environment, FieldDef } from '../orm/types';
import { isPyFloat } from '../orm/values';
import { envTz, userInfo } from '../orm/env';
import { formatTrackingDate, formatTrackingDatetime } from './tracking_format';
import { escapeText, messageLogBatch } from './message';
import { mailTranslate } from './i18n';
import { inX2manyCacheOrder } from '../orm/x2many_order';
import { contactAddressInline } from '../models/mail_address';
import * as priv from "../orm/dispatch_gen";

type Snapshot = Record<string, unknown>;
interface ModelTracking { depth: number; init: Map<number, Snapshot | null> }
const STATE = new WeakMap<Cursor, Map<string, ModelTracking>>();

function stateOf(cr: Cursor, model: string): ModelTracking {
  let byModel = STATE.get(cr);
  if (!byModel) STATE.set(cr, byModel = new Map());
  let st = byModel.get(model);
  if (!st) byModel.set(model, st = { depth: 0, init: new Map() });
  return st;
}

/** `_track_disabled` (mail_track_mixin.py:73). */
export function trackDisabled(env: Environment): boolean {
  return Boolean(env.context['tracking_disable'] || env.context['mail_notrack']);
}

/** `_track_get_fields` (mail_track_mixin.py:205): fields with `tracking`, restricted to those fields_get shows the user. */
export async function trackedFields(env: Environment, model: string): Promise<FieldDef[]> {
  const def = env.reg.model(model);
  const names = [...def.fields.values()].filter(f => f.descriptionTracking).map(f => f.name);
  for (const f of def.fields.values()) {
    if (f.type !== 'properties') continue;
    // mail_track_mixin.py:213-219: definitions with a tracked property track the field (not ported)
    const recField = f.definitionRecord ? def.fields.get(f.definitionRecord) : undefined;
    if (f.descriptionTracking || !recField?.relation || !f.definitionRecordField) throw new NotPorted(`tracking of properties field ${model}.${f.name}`);
    const table = env.reg.model(recField.relation).table;
    const tracked = (await env.cr.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${table}" WHERE jsonb_path_exists(COALESCE("${f.definitionRecordField}", '[]'::jsonb), '$[*] ? (@.tracking == true)')`)).rows[0];
    if (Number(tracked?.n ?? 0) > 0) throw new NotPorted(`tracking of properties field ${model}.${f.name} (tracked properties)`);
    // :221-227: tracked with its definition record; a change of a non-empty value refuses in displayValue
    if (names.includes(f.definitionRecord!)) names.push(f.name);
  }
  if (!names.length) return [];
  const visible = await env.model(model).fieldsGet(names, []);
  return names.filter(n => n in visible).map(n => def.fields.get(n)!);
}

/** `_track_discard` (mail_track_mixin.py:107): created records are not tracked for the rest of the transaction. */
export async function trackDiscard(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  if (!ids.length || !(await trackedFields(env, model)).length) return;
  const st = stateOf(env.cr, model);
  for (const id of ids) st.init.set(id, null);
}

/** `_fallback_lang` (mail_track_mixin.py:34) of the sudo environment the end values are read with. */
export function trackingEnv(env: Environment, lang: string | null): Environment {
  const clean = Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith('default_')));
  const l = env.context['lang'] || lang;
  return env.sudo().withContext(l ? { ...clean, lang: String(l) } : clean);
}

/** Values of the tracked fields as `_track_convert_value(record[fname])` would compare them. */
export async function readTracked(env: Environment, model: string, ids: readonly number[], fields: readonly FieldDef[]): Promise<Map<number, Snapshot>> {
  const out = new Map<number, Snapshot>();
  // base res_partner.py:586 `_compute_address`: a non-stored compute the read path does not serve (res.users
  // relates it through partner_id)
  const inlineField = (model === 'res.partner' || model === 'res.users') && fields.some(f => f.name === 'contact_address_inline');
  const plain = fields.filter(f => !(inlineField && f.name === 'contact_address_inline'));
  // monetary values are formatted with the record's currency (mail_track_mixin.py:510-516)
  const names = [...new Set([...plain.map(f => f.name), ...plain.filter(f => f.type === 'monetary').map(f => f.currencyField ?? 'currency_id')])];
  const rows = names.length ? await env.model(model).read(ids, names, '_classic_read') : ids.map(id => ({ id }));
  for (const r of rows) out.set(Number(r['id']), { ...r });
  if (inlineField) {
    const partnerOf = new Map<number, number>(ids.map(id => [id, id]));
    if (model === 'res.users') {
      for (const r of (await env.cr.query<{ id: number; partner_id: number }>('SELECT id, partner_id FROM res_users WHERE id = ANY($1::int[])', [ids])).rows) partnerOf.set(r.id, r.partner_id);
    }
    const inline = await contactAddressInline(env, [...new Set(partnerOf.values())]);
    for (const id of ids) out.get(id)!['contact_address_inline'] = inline.get(partnerOf.get(id)!) ?? false;
  }
  return out;
}

/**
 * WriteHooks.beforeWrite: `_track_prepare(self._fields)` (mail_track_mixin.py:76-100). `only` restricts it to some
 * fields, as `_track_prepare({'contact_address_inline'})` (mail res_partner.py:48-55); the initial values are a
 * `setdefault` per record and field (:94-97), so the first value of each field wins.
 */
export async function trackPrepare(env: Environment, model: string, ids: readonly number[], only?: readonly string[]): Promise<void> {
  const st = stateOf(env.cr, model);
  st.depth++;
  if (trackDisabled(env)) return;
  // while held, the model's first tracking keeps a level open until the next flush (`holdTracking`)
  const held = HELD.get(env.cr);
  if (held && ids.length && !held.some((h) => h.model === model)) { held.push({ model, env }); st.depth++; }
  let fields = await trackedFields(env, model);
  if (only) fields = fields.filter(f => only.includes(f.name));
  // mail_track_mixin.py:170 `_track_execute(initial_values, trackings)`, a hook: a module's override (l10n_fr_pdp:
  // its e-reporting fields left out and logged) takes Odoo's tracking structures, which the port does not build
  if (fields.length && ids.length && await priv.account_move._track_execute.overriddenOn(env, model)) throw new NotPorted(`tracking ${model} with a module's _track_execute`);
  // records inserted by this transaction are discarded (mail_thread.py:404), also before their create returns
  for (const id of ids) if (!st.init.has(id) && createdSinceCommit(env.cr, model, id)) st.init.set(id, null);
  // a discarded record (null) stays discarded (:95 `if record_values is not None`)
  const todo = ids.filter(id => { const cur = st.init.get(id); return cur !== null && (cur === undefined || fields.some(f => !(f.name in cur))); });
  if (!fields.length || !todo.length) return;
  const lang = (await userInfo(env)).lang;
  const values = await readTracked(trackingEnv(env, lang), model, todo, fields);
  for (const id of todo) {
    const cur = st.init.get(id), got = values.get(id) ?? {};
    if (!cur) { st.init.set(id, got); continue; }
    for (const [k, v] of Object.entries(got)) if (!(k in cur)) cur[k] = v;
  }
}

/** One mail.tracking.value dict of `_create_mail_tracking_values` (mail_track_mixin.py:456), the parts the template uses. */
interface TrackingValue {
  readonly name: string; readonly sequence: number; readonly label: string; readonly old: string; readonly new: string;
  /** mail_track_mixin.py:494-497: a company-dependent field's value is the environment company's, named before it */
  readonly company?: string;
}

/** `self.env.company.name` of the tracking environment, for a company-dependent field (mail_track_mixin.py:495-497). */
async function companyName(env: Environment): Promise<string> {
  const id = await env.company();
  return (await env.cr.query<{ name: string }>('SELECT name FROM res_company WHERE id = $1', [id])).rows[0]?.name ?? '';
}

function emptyish(v: unknown): boolean {
  return v === false || v === null || v === undefined || v === '' || (Array.isArray(v) && v.length === 0);
}

function sameValue(field: FieldDef, a: unknown, b: unknown): boolean {
  if (emptyish(a) && emptyish(b)) return true;
  if (field.type === 'many2one') return (Array.isArray(a) ? a[0] : a) === (Array.isArray(b) ? b[0] : b);
  // x2many: the same records (mail_track_mixin.py `_mail_track` compares the recordsets)
  if ((field.type === 'many2many' || field.type === 'one2many') && Array.isArray(a) && Array.isArray(b)) {
    const sa = [...a].map(Number).sort((x, y) => x - y), sb = [...b].map(Number).sort((x, y) => x - y);
    return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
  }
  // float/monetary read values are PyFloat wrappers (src/orm/values.ts): compare the numbers
  if (isPyFloat(a) || isPyFloat(b)) return (isPyFloat(a) ? a.float : a) === (isPyFloat(b) ? b.float : b);
  return a === b;
}

/** res.lang `format` (base/models/res_lang.py) of `%.{digits}f`: grouping [3,0] with the lang's separators. */
export async function langNumber(env: Environment, lang: string, value: number, digits: number): Promise<string> {
  const row = (await env.cr.query<{ grouping: string; thousands_sep: string | null; decimal_point: string }>(
    'SELECT grouping, thousands_sep, decimal_point FROM res_lang WHERE code = $1', [lang])).rows[0];
  if (!row || row.grouping !== '[3,0]') throw new NotPorted(`number grouping of ${lang}`);
  const fixed = Math.abs(value).toFixed(digits);
  const [int, dec] = fixed.split('.');
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, row.thousands_sep ?? '');
  return `${value < 0 && Number(fixed) !== 0 ? '-' : ''}${grouped}${dec !== undefined ? row.decimal_point + dec : ''}`;
}

/** tools/float_utils.py float_round HALF-EVEN / HALF-UP to `digits` decimals (ties decided on the scaled value). */
function roundTo(value: number, digits: number, method: 'HALF-EVEN' | 'HALF-UP'): number {
  const f = 10 ** digits, scaled = value * f, fl = Math.floor(scaled), diff = scaled - fl;
  const eps = 1e-9 * Math.max(1, Math.abs(scaled));
  let r: number;
  if (Math.abs(diff - 0.5) <= eps) r = method === 'HALF-UP' ? (value >= 0 ? fl + 1 : fl) : (fl % 2 === 0 ? fl : fl + 1);
  else r = Math.round(scaled);
  return r / f;
}

async function displayValue(env: Environment, field: FieldDef, value: unknown, lang: string, record: Readonly<Record<string, unknown>>, model = ''): Promise<string> {
  switch (field.type) {
    case 'char': case 'text':
      return emptyish(value) ? 'None' : String(value);
    case 'many2one':
      // :554 `(id, display_name)`, 'None' for an empty value or an empty name
      return Array.isArray(value) && value[1] ? String(value[1]) : 'None';
    case 'selection': {
      if (emptyish(value)) return 'None';
      const sel = field.selection?.find(s => s.value === value);
      if (sel) return sel.labels[lang] ?? sel.label;
      // a selection given by a method (fields_get resolves it): the registered selection hook
      const hook = model ? hooksOf(model).selection?.[field.name] : undefined;
      const entry = hook ? (await hook(env)).find(([v]) => v === value) : undefined;
      if (!entry) throw new NotPorted(`tracking of callable selection ${field.name}`);
      return entry[1];
    }
    case 'boolean':
      return mailTranslate(lang, value ? 'Yes' : 'No');
    case 'integer': case 'float': {
      // mail_track_mixin.py:504-507 formatLang(value or 0, rounding_unit units|decimals): 0 or 2 digits, HALF-EVEN
      // a float read value may come as a PyFloat (0.1 before a write): Number() of it was NaN
      const n = typeof value === 'number' ? value : isPyFloat(value) ? value.float : Number(value || 0);
      const digits = field.type === 'integer' ? 0 : 2;
      return langNumber(env, lang, roundTo(n, digits, 'HALF-EVEN'), digits);
    }
    case 'monetary': {
      // :510-523 format_amount(value or 0, record[currency_field]) (misc.py:1603)
      const cur = record[field.currencyField ?? 'currency_id'];
      const cid = Array.isArray(cur) ? cur[0] : cur;
      const plainValue = isPyFloat(value) ? value.float : value;
      if (typeof cid !== 'number') return emptyish(plainValue) ? 'None' : String(plainValue);
      const c = (await env.cr.query<{ symbol: string | null; position: string; decimal_places: number; rounding: string }>(
        'SELECT symbol, position, decimal_places, rounding FROM res_currency WHERE id = $1', [cid])).rows[0]!;
      const n = typeof plainValue === 'number' ? plainValue : Number(plainValue || 0);
      if (Math.abs(Number(c.rounding) - 10 ** -c.decimal_places) > 1e-12) throw new NotPorted('currency rounding other than its decimal places');
      const amount = (await langNumber(env, lang, roundTo(n, c.decimal_places, 'HALF-UP'), c.decimal_places)).replace(/ /g, '\u00a0').replace(/-/g, '-\ufeff');
      return c.position === 'before' ? `${c.symbol ?? ''}\u00a0${amount}` : `${amount}\u00a0${c.symbol ?? ''}`;
    }
    case 'date': {
      // :536-542 `_format_tracking_date`: babel's medium date of the language
      if (emptyish(value)) return 'None';
      return formatTrackingDate(String(value), lang);
    }
    case 'datetime': {
      // :631-640 `_format_tracking_datetime`: babel's "{1}, {0}" of the medium date and short time, then (ZZZZ), in env.tz
      if (emptyish(value)) return 'None';
      return formatTrackingDatetime(String(value), await envTz(env), lang);
    }
    case 'many2many': case 'one2many': {
      // mail_track_mixin.py:580-616: the records' display names joined by ', ', 'None' when empty
      const ids = Array.isArray(value) ? value.map((v) => (Array.isArray(v) ? Number(v[0]) : Number(v))) : [];
      if (!ids.length || !field.relation) return 'None';
      const names = await env.model(field.relation).displayName(ids);
      const out: string[] = [];
      for (const id of ids) {
        const n = names.get(id);
        if (!n) throw new NotPorted(`tracking of ${field.name}: an unnamed ${field.relation} record`);
        out.push(n);
      }
      return out.join(', ');
    }
    default:
      throw new NotPorted(`tracking of ${field.type} field ${field.name} (format_date/format_datetime)`);
  }
}

/**
 * `mail.mail_tracking_template` (data/mail_templates_chatter.xml:80) after `_message_compute_body_with_trackings`
 * (mail_thread.py:3144): values in ascending (tracking_sequence, name) order, joined by `<br>`.
 */
export function trackingBody(values: readonly TrackingValue[]): string {
  const sorted = [...values].sort((a, b) => a.sequence - b.sequence || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // mail_templates_chatter.xml:83 `mail_tracking_template`: `<em t-if="val.get('company_name')">` with its indentation
  const em = (v: TrackingValue): string => v.company ? `\n        <em>${escapeText(`${v.company}: `)}</em>` : '';
  return `<div>${sorted.map(v => `${em(v)}${escapeText(v.old)} → <b>${escapeText(v.new)}</b> <i>(${escapeText(v.label)})</i>`).join('<br>').replace(/\u00a0/g, '&nbsp;')}\n</div>`;
}

/** The tracking result of one record: the changed field names (`changes`) and the tracking html. */
export interface TrackedChange { readonly changes: readonly string[]; readonly init: Readonly<Record<string, unknown>>; readonly body: string }

/**
 * When the outermost write of `model` returns: `_track_finalize` (mail_track_mixin.py:133) up to the tracking values,
 * one entry per record with changes, in snapshot order; null when this is a nested write. `trackFinalize` logs them;
 * models with `_track_log_get_default_subtype` (crm.lead) post them themselves (src/models/crm_lead_mail.ts).
 */
export async function trackCollect(env: Environment, model: string): Promise<{ env: Environment; changes: Map<number, TrackedChange> } | null> {
  const st = stateOf(env.cr, model);
  st.depth = Math.max(0, st.depth - 1);
  if (st.depth > 0) return null;
  const pending = [...st.init].filter((e): e is [number, Snapshot] => e[1] !== null);
  // pop the snapshots (:142); discarded (null) records stay discarded for the transaction
  for (const [id] of pending) st.init.delete(id);
  const out = new Map<number, TrackedChange>();
  if (!pending.length) return { env, changes: out };
  const fields = await trackedFields(env, model);
  const lang = env.context['lang'] ? String(env.context['lang']) : (await userInfo(env)).lang ?? 'en_US';
  const tenv = trackingEnv(env, lang);
  const live = new Set(await tenv.withContext({ ...tenv.context, active_test: false }).model(model).search({ kind: 'cond', path: 'id', op: 'in', value: pending.map(p => p[0]) }));
  const ids = pending.map(p => p[0]).filter(id => live.has(id)); // :160 MissingError: deleted meanwhile
  if (!ids.length) return { env: tenv, changes: out };
  const end = await readTracked(tenv, model, ids, fields);
  // `record[fname]` at finalize is the cache: a many2many in the order its write left it (src/orm/x2many_order.ts)
  for (const f of fields) {
    if (f.type !== 'many2many') continue;
    for (const [id, row] of end) if (Array.isArray(row[f.name])) row[f.name] = inX2manyCacheOrder(env.cr, model, f.name, id, (row[f.name] as unknown[]).map(Number));
  }
  // `_track_get_fields_info` (mail_track_mixin.py:232): fields_get labels (format.vat.label.mixin renames `vat`)
  const info = await tenv.model(model).fieldsGet(fields.map(f => f.name), ['string']);
  for (const [id, init] of pending) {
    if (!live.has(id)) continue;
    const now = end.get(id)!;
    const values: TrackingValue[] = [];
    for (const f of fields) {
      if (!(f.name in init)) continue;
      if (sameValue(f, init[f.name], now[f.name])) continue;
      values.push({ name: f.name, sequence: f.trackingSequence ?? 100, label: String(info[f.name]?.['string'] ?? f.string),
        old: await displayValue(tenv, f, init[f.name], lang, now, model), new: await displayValue(tenv, f, now[f.name], lang, now, model),
        ...(f.companyDependent ? { company: await companyName(tenv) } : {}) });
    }
    if (values.length) out.set(id, { changes: values.map(v => v.name), init, body: trackingBody(values) });
  }
  return { env: tenv, changes: out };
}

const LOG_MSG = new WeakMap<Cursor, Map<string, Map<number, string>>>();

/** mail_thread.py:570-574 `_track_set_log_message(message)`: optional leading body on the next tracking log. */
export function setTrackLogMessage(cr: Cursor, model: string, ids: readonly number[], message: string): void {
  let byModel = LOG_MSG.get(cr);
  if (!byModel) LOG_MSG.set(cr, byModel = new Map());
  let byId = byModel.get(model);
  if (!byId) byModel.set(model, byId = new Map());
  for (const id of ids) byId.set(id, message);
}

/** WriteHooks.afterWrite: when the outermost write returns, `_track_finalize` + `_track_log` (mail_thread.py:628). */
export async function trackFinalize(env: Environment, model: string): Promise<void> {
  const collected = await trackCollect(env, model);
  const logMsgs = LOG_MSG.get(env.cr)?.get(model);
  if (logMsgs) LOG_MSG.get(env.cr)!.delete(model);
  if (!collected || !collected.changes.size) return;
  const bodies = new Map([...collected.changes].map(([id, c]) => {
    const prefix = logMsgs?.get(id);
    return [id, prefix ? `${prefix}${c.body}` : c.body];
  }));
  // `_track_log_get_default_subtype` is empty for the ported models: `_message_log_batch` (:684), author env.user.
  await messageLogBatch(collected.env, model, bodies, { messageType: 'tracking' });
}

/**
 * Odoo logs tracking at precommit (`_track_finalize`, mail_track_mixin.py:91, :133), which `cr.flush()` runs: after
 * each data file of a module install (loading.py:58) and when a savepoint flushes. The port logs it when a model's
 * outermost write returns; while a cursor holds its tracking (a module install's data files, src/modules/install.ts),
 * a model's first tracking opens one more level, which `heldTrackingModels` hands over at the flush, in the order
 * of the models' first tracking (the order Odoo added their `_track_finalize`).
 */
/** Per cursor, the held models with the environment of their first tracking (`self` of Odoo's `_track_finalize`). */
const HELD = new WeakMap<Cursor, { model: string; env: Environment }[]>();
export function holdTracking(cr: Cursor): void {
  if (!HELD.has(cr)) HELD.set(cr, []);
}
/** Stop holding: the models whose held level the caller must close, in order, with the environment to close it in. */
export function heldTrackingModels(cr: Cursor): { model: string; env: Environment }[] {
  const list = HELD.get(cr) ?? [];
  HELD.delete(cr);
  return list;
}
export function trackingHeld(cr: Cursor): boolean {
  return HELD.has(cr);
}
/** Stop holding after a rolled-back step: the held levels are closed and their snapshots dropped, nothing logged. */
export function dropHeldTracking(cr: Cursor): void {
  for (const { model } of heldTrackingModels(cr)) {
    const st = STATE.get(cr)?.get(model);
    if (!st) continue;
    st.depth = Math.max(0, st.depth - 1);
    if (st.depth === 0) for (const [id, v] of st.init) if (v !== null) st.init.delete(id);
  }
}

/** Close a tracking level opened by `trackPrepare` without logging (the operation that opened it raised). */
export function trackAbortLevel(cr: Cursor, model: string): void {
  const st = STATE.get(cr)?.get(model);
  if (st) st.depth = Math.max(0, st.depth - 1);
}

/** The write depth of `model` in this request (> 0 while one of its writes is open). */
export function trackDepth(cr: Cursor, model: string): number {
  return STATE.get(cr)?.get(model)?.depth ?? 0;
}

/** The first model (in the order its tracking state was made) other than `except` with an open write, else null. */
export function openTrackingModel(cr: Cursor, except: string): string | null {
  for (const [model, st] of STATE.get(cr) ?? []) if (model !== except && st.depth > 0) return model;
  return null;
}

const AFTER = new WeakMap<Cursor, Map<string, (() => Promise<void>)[]>>();

/**
 * Run `fn` after the tracking of `model`'s outermost open write is logged (Odoo runs the precommit `_track_finalize`
 * functions in the order they were added: a parent's write prepares its tracking before its lines are written).
 */
export function afterTracking(cr: Cursor, model: string, fn: () => Promise<void>): void {
  let byModel = AFTER.get(cr);
  if (!byModel) AFTER.set(cr, byModel = new Map());
  const list = byModel.get(model) ?? [];
  list.push(fn);
  byModel.set(model, list);
}

/** Called by the thread hooks when the outermost write of `model` returned and its tracking was logged. */
export async function runAfterTracking(env: Environment, model: string): Promise<void> {
  if (trackDepth(env.cr, model) > 0) return;
  const list = AFTER.get(env.cr)?.get(model);
  while (list?.length) await list.shift()!();
}

interface TargetTracking { depth: number; init: Map<number, Snapshot>; fields: FieldDef[]; target: Map<number, { model: string; id: number; body: string }> }
const TARGETS = new WeakMap<Cursor, Map<string, TargetTracking>>();

function targetStateOf(cr: Cursor, model: string): TargetTracking {
  let byModel = TARGETS.get(cr);
  if (!byModel) TARGETS.set(cr, byModel = new Map());
  let st = byModel.get(model);
  if (!st) byModel.set(model, st = { depth: 0, init: new Map(), fields: [], target: new Map() });
  return st;
}

/**
 * `parent._track_record(records, fnames, body=...)` (mail_track_mixin.py:298, mail_thread.py:611) without initial
 * values: `_track_prepare(fnames)` of the records (first snapshot wins) and the parent with the log body per record.
 * Every call must be closed by `trackRecordFinalize` (also when `ids` is empty: it counts the write depth).
 */
export async function trackRecordPrepare(env: Environment, model: string, fields: readonly FieldDef[],
  targets: ReadonlyMap<number, { model: string; id: number; body: string }>): Promise<void> {
  const st = targetStateOf(env.cr, model);
  st.depth++;
  const todo = [...targets.keys()].filter(id => !st.init.has(id));
  for (const [id, t] of targets) st.target.set(id, t);
  for (const f of fields) if (!st.fields.some(g => g.name === f.name)) st.fields.push(f);
  if (!todo.length || !fields.length) return;
  for (const t of new Set([...targets.values()].map((x) => x.model))) {
    if (await priv.account_move._track_execute.overriddenOn(env, t)) throw new NotPorted(`tracking on ${t} with a module's _track_execute`);
  }
  const lang = (await userInfo(env)).lang;
  const values = await readTracked(trackingEnv(env, lang), model, todo, fields);
  for (const id of todo) st.init.set(id, values.get(id) ?? {});
}

/**
 * `parent._track_record(records, fnames, initial_values=..., body=...)` inside an open `trackRecordPrepare` scope (it
 * does not count a level): the given initial values are added per field (`_track_add_data_values` setdefault,
 * mail_track_mixin.py:56-69), the target and its body replaced (`_track_set_log_message_for_target`).
 */
export function trackRecordAdd(cr: Cursor, model: string, fields: readonly FieldDef[], init: ReadonlyMap<number, Snapshot>,
  targets: ReadonlyMap<number, { model: string; id: number; body: string }>): void {
  const st = targetStateOf(cr, model);
  if (st.depth <= 0) throw new NotPorted(`_track_record of ${model} outside a tracking scope`);
  for (const [id, values] of init) {
    const cur = st.init.get(id);
    if (!cur) { st.init.set(id, { ...values }); continue; }
    for (const [k, v] of Object.entries(values)) if (!(k in cur)) cur[k] = v;
  }
  for (const [id, t] of targets) st.target.set(id, t);
  for (const f of fields) if (!st.fields.some(g => g.name === f.name)) st.fields.push(f);
}

/**
 * When the outermost write of `model` returns: the records' `_track_finalize` (mail_track_mixin.py:133-196) whose
 * changes are executed on the parents (`_track_execute` → `_track_log`, mail_thread.py:628): one `_message_log_batch`
 * per record, body = the logged body followed by the tracking values (`_message_compute_body_with_trackings`). The
 * parent model's `_track_log_get_default_subtype` sees the records' field names only, so no subtype for account.move.
 */
export async function trackRecordFinalize(env: Environment, model: string): Promise<void> {
  const st = targetStateOf(env.cr, model);
  st.depth = Math.max(0, st.depth - 1);
  if (st.depth > 0) return;
  const pending = [...st.init];
  const targets = new Map(st.target), fields = [...st.fields];
  st.init.clear(); st.target.clear(); st.fields = [];
  if (!pending.length) return;
  const lang = env.context['lang'] ? String(env.context['lang']) : (await userInfo(env)).lang ?? 'en_US';
  const tenv = trackingEnv(env, lang);
  const live = new Set(await tenv.withContext({ ...tenv.context, active_test: false }).model(model).search({ kind: 'cond', path: 'id', op: 'in', value: pending.map(p => p[0]) }));
  const ids = pending.map(p => p[0]).filter(id => live.has(id));
  if (!ids.length) return;
  const end = await readTracked(tenv, model, ids, fields);
  // `record[fname]` at finalize is the cache: a many2many in the order its write left it (src/orm/x2many_order.ts)
  for (const f of fields) {
    if (f.type !== 'many2many') continue;
    for (const [id, row] of end) if (Array.isArray(row[f.name])) row[f.name] = inX2manyCacheOrder(env.cr, model, f.name, id, (row[f.name] as unknown[]).map(Number));
  }
  const info = await tenv.model(model).fieldsGet(fields.map(f => f.name), ['string']);
  for (const [id, init] of pending) {
    if (!live.has(id)) continue;
    const now = end.get(id)!;
    const values: TrackingValue[] = [];
    for (const f of fields) {
      if (!(f.name in init) || sameValue(f, init[f.name], now[f.name])) continue;
      values.push({ name: f.name, sequence: f.trackingSequence ?? 100, label: String(info[f.name]?.['string'] ?? f.string),
        old: await displayValue(tenv, f, init[f.name], lang, now, model), new: await displayValue(tenv, f, now[f.name], lang, now, model),
        ...(f.companyDependent ? { company: await companyName(tenv) } : {}) });
    }
    const t = targets.get(id);
    if (!values.length || !t) continue;
    // escape(body) through mail.message's Html field: the leading inline content becomes a paragraph
    await messageLogBatch(tenv, t.model, new Map([[t.id, `<p>${t.body}</p>${trackingBody(values)}`]]), { messageType: 'tracking' });
  }
}

/**
 * `parent._track_record(record, fnames, end_values={id: empty values}, body=...)` followed at once by
 * `record._track_finalize()`, per record (account_move_line.py:2351-2363, "fire now: one track / line"): the tracked
 * values of a record about to be deleted against the empty values of its fields (`empty_line[fname]`: False, 0.0, no
 * records), logged on its parent. `_track_finalize` pops every pending tracking of the model, so a record of a model
 * with a tracking scope open refuses (the other records' trackings would be flushed with it).
 */
export async function trackRecordDeleted(env: Environment, model: string, fields: readonly FieldDef[],
  targets: ReadonlyMap<number, { model: string; id: number; body: string }>): Promise<void> {
  if (!targets.size || !fields.length) return;
  const st = targetStateOf(env.cr, model);
  if (st.depth > 0 || st.init.size) throw new NotPorted(`_track_finalize of a deleted ${model} with other trackings pending`);
  const lang = env.context['lang'] ? String(env.context['lang']) : (await userInfo(env)).lang ?? 'en_US';
  const tenv = trackingEnv(env, lang);
  const ids = [...targets.keys()];
  const init = await readTracked(tenv, model, ids, fields);
  const info = await tenv.model(model).fieldsGet(fields.map(f => f.name), ['string']);
  const empty = (f: FieldDef): unknown => f.type === 'many2many' || f.type === 'one2many' ? []
    : f.type === 'monetary' || f.type === 'float' || f.type === 'integer' ? 0 : false;
  for (const [id, t] of targets) {
    const before = init.get(id) ?? {};
    const values: TrackingValue[] = [];
    for (const f of fields) {
      if (!(f.name in before) || sameValue(f, before[f.name], empty(f))) continue;
      // the record still exists when it is tracked (its currency for monetary values)
      values.push({ name: f.name, sequence: f.trackingSequence ?? 100, label: String(info[f.name]?.['string'] ?? f.string),
        old: await displayValue(tenv, f, before[f.name], lang, before, model), new: await displayValue(tenv, f, empty(f), lang, before, model),
        ...(f.companyDependent ? { company: await companyName(tenv) } : {}) });
    }
    if (!values.length) continue;
    await messageLogBatch(tenv, t.model, new Map([[t.id, `<p>${t.body}</p>${trackingBody(values)}`]]), { messageType: 'tracking' });
  }
}

/**
 * A commit inside the request (`button_immediate_install`, ir_module.py:645): the precommit data is gone, so the records
 * whose tracking was discarded at their creation are tracked again by later writes (src/orm/created.ts noteCommitPoint).
 */
export function trackCommitPoint(cr: Cursor): void {
  for (const st of STATE.get(cr)?.values() ?? []) {
    if (st.depth > 0) throw new NotPorted('a commit inside the request with a tracking level open');
    for (const [id, v] of st.init) if (v === null) st.init.delete(id);
  }
}

/**
 * A savepoint's flush (sql_db.py:295-304, a chart's demo install, chart_template.py:253): the precommit's
 * `_track_finalize` pops the tracking data, the discards of the records created so far with it, so their later writes
 * are tracked again. A level still open with discarded records refuses (its data would be popped mid-write).
 */
export function trackSavepointFlush(cr: Cursor): void {
  for (const st of STATE.get(cr)?.values() ?? []) {
    const discarded = [...st.init].filter(([, v]) => v === null).map(([id]) => id);
    if (!discarded.length) continue;
    if (st.depth > 0) throw new NotPorted('a savepoint flush with a tracking level open on records whose tracking was discarded');
    for (const id of discarded) st.init.delete(id);
  }
}
