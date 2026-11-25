/**
 * mail.activity on the write path (odoo/addons/mail/models/mail_activity.py): the Python field defaults (:95
 * `_default_activity_type` :44-56, :112 technical_usage, :139 active) and the stored computes the ORM core runs on
 * create/write (:159-279). Related stored fields (res_model, user_tz) are generic. `_get_date_deadline` of activity
 * types with a delay is not ported (refuses).
 */
import { NotPorted } from '../errors';
import { registerDefaults, registerRecordCompute, type Rec } from '../orm/recompute';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { dbNow, todayInTz } from './util';

interface TypeRow { summary: string | null; name: string | null; default_note: string | null; default_user_id: number | null; default_role_id: number | null; delay_count: number | null; delay_unit: string | null; delay_from: string | null; category: string | null }

async function activityType(env: Environment, rec: Rec): Promise<TypeRow | null> {
  const id = await rec.get('activity_type_id');
  if (typeof id !== 'number') return null;
  const lang = env.lang ?? 'en_US';
  return (await env.cr.query<TypeRow>(
    `SELECT COALESCE(summary->>$2, summary->>'en_US') AS summary, COALESCE(name->>$2, name->>'en_US') AS name,
            COALESCE(default_note->>$2, default_note->>'en_US') AS default_note, default_user_id, default_role_id, delay_count, delay_unit, delay_from, category
       FROM mail_activity_type WHERE id = $1`, [id, lang])).rows[0] ?? null;
}

/** `date + relativedelta(**{unit: count})` for days, weeks and months (a month keeps the day, clamped to the month's end). */
export function addDelay(date: string, unit: string, count: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  let out: Date;
  if (unit === 'days' || unit === 'weeks') out = new Date(Date.UTC(y, m - 1, d + count * (unit === 'weeks' ? 7 : 1)));
  else if (unit === 'months') {
    const total = y * 12 + (m - 1) + count;
    const ny = Math.floor(total / 12), nm = total - ny * 12;
    const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
    out = new Date(Date.UTC(ny, nm, Math.min(d, last)));
  } else throw new NotPorted(`activity type delay unit ${unit}`);
  return out.toISOString().slice(0, 10);
}

async function contextToday(env: Environment): Promise<string> {
  const tz = typeof env.context['tz'] === 'string' && env.context['tz'] ? env.context['tz'] : (await userInfo(env)).tz || 'UTC';
  return todayInTz(await dbNow(env), tz);
}

registerDefaults('mail.activity', {
  // :44-56 `_default_activity_type`: the context's res_model(_id) default, else the first generic type (sequence, id)
  activity_type_id: async (env) => {
    let model: unknown = env.context['default_res_model'];
    if (env.context['default_res_model_id']) {
      model = (await env.cr.query<{ model: string }>('SELECT model FROM ir_model WHERE id = $1', [env.context['default_res_model_id']])).rows[0]?.model;
    }
    const row = model
      ? (await env.cr.query<{ id: number }>('SELECT id FROM mail_activity_type WHERE active IS TRUE AND (res_model = $1 OR res_model IS NULL) ORDER BY sequence, id LIMIT 1', [model])).rows[0]
      : (await env.cr.query<{ id: number }>('SELECT id FROM mail_activity_type WHERE active IS TRUE AND res_model IS NULL ORDER BY sequence, id LIMIT 1')).rows[0];
    return row?.id ?? false;
  },
  technical_usage: async () => 'none',
  active: async () => true,
});

/**
 * mail_activity.py:195-221 `_get_phone_numbers_by_activity` for one activity (a stored compute, so as superuser): the
 * record's own `phone` (`_get_phone_number_from_record`, no installed module overrides it), else the phone of its first
 * customer, models.py:163-201 `_mail_get_partners(introspect_fields=True)`: the values of `partner_id` then
 * `partner_ids` (whichever exist), else of every many2one to res.partner. A missing record has no number (MissingError).
 * Before round 11 a call activity on a record refused at its creation.
 */
/**
 * `_get_phone_number_from_record(record)`: mail's `record.phone` (mail_activity.py:223-225), or with phone_validation
 * installed (phone_validation/models/mail_activity.py:9-15, res.partner then has `phone_formatted`) the record's
 * formatted number, else its number fields (models.py:16-21 `_phone_get_number_fields`: mobile, phone).
 */
async function numberOfRecord(env: Environment, model: string, id: number): Promise<string | false> {
  const def = env.reg.model(model);
  if (!env.reg.model('res.partner').fields.has('phone_formatted')) {
    const own = def.fields.has('phone') ? (await env.model(model).read([id], ['phone'], ''))[0]?.['phone'] : false;
    return typeof own === 'string' && own ? own : false;
  }
  if (['hr.employee', 'hr.applicant'].includes(model)) throw new NotPorted(`phone of a call activity on ${model} (its _phone_get_number_fields)`);
  const fields = [...(def.fields.has('phone_formatted') ? ['phone_formatted'] : []), ...['mobile', 'phone'].filter((f) => def.fields.has(f))];
  if (!fields.length) return false;
  const row = (await env.model(model).read([id], fields, ''))[0] ?? {};
  for (const f of fields) {
    const v = row[f];
    if (typeof v === 'string' && v) return v;
  }
  return false;
}

export async function phoneOfRecord(env0: Environment, model: string, id: number): Promise<string | false> {
  const env = env0.sudo();
  if (!env.reg.models.has(model)) throw new NotPorted(`phone of a call activity on the unknown model ${model}`);
  const def = env.reg.model(model);
  const exists = (await env.cr.query(`SELECT 1 FROM "${def.table}" WHERE id = $1`, [id])).rows.length > 0;
  if (!exists) return false;
  const own = await numberOfRecord(env, model, id);
  if (own) return own;
  let fnames = ['partner_id', 'partner_ids'].filter((f) => def.fields.has(f));
  let introspected = false;
  if (!fnames.length) {
    fnames = [...def.fields.values()].filter((f) => f.type === 'many2one' && f.relation === 'res.partner').map((f) => f.name);
    introspected = true;
  }
  if (!fnames.length) return false;
  const row = (await env.model(model).read([id], fnames, ''))[0] ?? {};
  const filled = fnames.filter((f) => { const v = row[f]; return Array.isArray(v) ? v.length > 0 : typeof v === 'number' && v > 0; });
  // the introspected fields come in `_fields` order, which the port's registry does not promise
  if (introspected && filled.length > 1) throw new NotPorted(`phone of a call activity on ${model}: several partner many2one fields set (_fields order)`);
  for (const f of filled) {
    const v = row[f];
    const pid = Array.isArray(v) ? v[0] : v;
    if (typeof pid !== 'number') continue;
    return numberOfRecord(env, 'res.partner', pid);
  }
  return false;
}

registerRecordCompute('mail.activity', {
  // :159-165 `_compute_date_done`: cleared when active, the UTC date of now when archived (earliest kept)
  date_done: async (env, rec) => {
    if (await rec.get('active')) return false;
    const prev = await rec.prev('date_done');
    return prev || (await dbNow(env)).toISOString().slice(0, 10);
  },
  // :167-172 `_compute_res_name` (compute_sudo): the document's display name
  res_name: async (env, rec) => {
    const model = await rec.get('res_model'), id = await rec.get('res_id');
    if (typeof model !== 'string' || !model || typeof id !== 'number' || !id) return false;
    return (await env.sudo().model(model).displayName([id])).get(id) ?? false;
  },
  // :182-193 `_compute_phone`: only phone call activities of saved records carry a number
  phone: async (env, rec) => {
    const t = await activityType(env, rec);
    const model = await rec.get('res_model'), resId = await rec.get('res_id');
    if (rec.id === null || t?.category !== 'phonecall' || typeof model !== 'string' || !model || typeof resId !== 'number' || !resId) return false;
    return phoneOfRecord(env, model, resId);
  },
  // :245-251 `_compute_date_deadline`
  date_deadline: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.delay_count) {
      // mail_activity_type.py:153-160 `_get_date_deadline`: today (or the previous activity's deadline) plus the delay
      const previous = env.context['activity_previous_deadline'];
      let base: string;
      if (t.delay_from === 'previous_activity' && previous) {
        if (typeof previous !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(previous)) throw new NotPorted('activity_previous_deadline that is not a date');
        base = previous;
      } else base = await contextToday(env);
      return addDelay(base, t.delay_unit ?? 'days', t.delay_count);
    }
    return (await rec.prev('date_deadline')) || await contextToday(env);
  },
  // :253-256 `_compute_note`
  note: async (env, rec) => {
    const t = await activityType(env, rec);
    return t?.default_note ? t.default_note : await rec.prev('note');
  },
  // :258-263 `_compute_summary`
  summary: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t?.summary) return t.summary;
    return (await rec.prev('summary')) || (t?.name ?? false);
  },
  // :265-270 `_compute_user_id`
  user_id: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t && (t.default_user_id || t.default_role_id)) return t.default_user_id ?? false;
    const prev = await rec.prev('user_id');
    if (!prev && !(await rec.prev('role_id'))) return env.uid;
    return prev;
  },
  // :272-276 `_compute_role_id`
  role_id: async (env, rec) => {
    const t = await activityType(env, rec);
    if (t && (t.default_user_id || t.default_role_id)) return t.default_role_id ?? false;
    return rec.prev('role_id');
  },
});
