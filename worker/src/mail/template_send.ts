/**
 * mail.template as data (D23, väg B): any template of the database rendered and sent, not one written out per template.
 *
 * - `send_mail` / `send_mail_batch` (mail/models/mail_template.py:701-858): the access check, `_generate_template`
 *   (:588-679) with the language split (`_classify_per_lang`, mail_render_mixin.py:754-803), the rendered fields
 *   (`_render_field` :805-883 through src/qweb/mail_render.ts), the recipients (:411-531, mail/models/models.py:238-365
 *   `_message_get_default_recipients`), the scheduled date, the static values and the attachments (:338-409), then the
 *   layout (`_render_encapsulate`, mail_render_mixin.py:194-262: the layout view rendered from the database) and
 *   `mail.mail.sudo().create` (src/mail/mail_mail_create.ts, its mail.message through `_inherits`).
 * - `generateTemplate` is shared with the composer (src/mail/composer.ts) for message_post_with_source.
 *
 * Refused (NotPorted), never guessed: rendering as a user who is not an administrator (the field-level access checks of
 * what the template reads), models whose recipient or partner methods are overridden in Python, alias domains,
 * recipients only by email address, report attachments with a PDF engine, `force_send`, website base URLs.
 */
import { NotPorted, UserError } from '../errors';
import { registerMethod } from '../http/methods';
import { create } from '../orm/create';
import { cond } from '../orm/domain';
import type { Environment } from '../orm/types';
import { hasPdfEngine } from '../report/engine';
import { renderQweb } from '../controllers/report';
import { renderTemplateField, replaceLocalLinks, type TemplateField } from '../qweb/mail_render';
import { PyRecords, registerPyMethod, RENDER_AS_USER } from '../qweb/records';
import { isHtmlEmpty } from '../qweb/helpers';
import { Markup, PyObject } from '../pyexpr/values';
import { messagePreview } from '../models/mail_notify_layout';
import { userHasGroup } from '../web/groups';
import { envFor } from '../web/common';
import { emailNormalize } from './message';
import { LazyTerm } from '../orm/lazy_term';
import { translate } from '../models/util';

export interface TemplateRow {
  readonly id: number;
  readonly model: string;
  readonly lang: string | null;
  readonly use_default_to: boolean;
  readonly email_layout_xmlid: string | null;
  readonly auto_delete: boolean;
  readonly mail_server_id: number | null;
  readonly email_to: string | null;
  readonly email_cc: string | null;
  readonly partner_to: string | null;
  readonly partner_cc: string | null;
  readonly scheduled_date: string | null;
}

export async function templateRow(env: Environment, id: number): Promise<TemplateRow> {
  const t = (await env.cr.query<TemplateRow>(
    `SELECT id, model, lang, use_default_to IS TRUE AS use_default_to, email_layout_xmlid, auto_delete IS TRUE AS auto_delete, mail_server_id,
            email_to, email_cc, partner_to, partner_cc, scheduled_date FROM mail_template WHERE id = $1`, [id])).rows[0];
  if (!t) throw new NotPorted(`mail.template ${id} that does not exist (MissingError)`);
  if (!t.model) throw new NotPorted('mail.template without a model');
  return t;
}

/** Models whose `_message_add_default_recipients`, `_mail_get_partner_fields`, `_mail_get_partners` or
 *  `_mail_defaults_to_email` differ from mail/models/models.py (grep of odoo/addons, tests excluded). res.partner's
 *  `_mail_get_partners` (mail/models/res_partner.py:57-58: the partner itself) is ported below. */
const RECIPIENT_OVERRIDES = new Set(['calendar.attendee', 'event.registration', 'event.track', 'gamification.badge.user', 'gamification.goal',
  'hr.employee', 'loyalty.card', 'slide.slide', 'slide.channel']);

/** `_primary_email` (mail_thread.py:148, mail_thread_blacklist.py:32 'email'; the models that set another). */
const PRIMARY_EMAIL: Readonly<Record<string, string>> = {
  'crm.lead': 'email_from', 'project.task': 'email_from', 'hr.employee': 'work_email', 'event.track': 'contact_email',
  'mail.group.message': 'email_from', 'hr.applicant': 'email_from',
};

function refuseRecipientOverrides(model: string): void {
  if (RECIPIENT_OVERRIDES.has(model)) throw new NotPorted(`default recipients of ${model} (its Python override)`);
}

/** models.py:187-201 `_mail_get_partners` (res_partner.py:57-58 for partners): the partners of partner_id then partner_ids. */
export async function mailGetPartners(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, number[]>> {
  refuseRecipientOverrides(model);
  const out = new Map<number, number[]>();
  if (model === 'res.partner') {
    for (const id of ids) out.set(id, [id]);
    return out;
  }
  const def = env.reg.model(model);
  // :176 `fname in self`: the fields that exist, whatever their comodel
  const fields = ['partner_id', 'partner_ids'].filter((f) => def.fields.has(f));
  for (const f of fields) if (def.fields.get(f)!.relation !== 'res.partner') throw new NotPorted(`${model}.${f} towards ${def.fields.get(f)!.relation}`);
  const rows: Record<string, unknown>[] = fields.length ? await env.model(model).read(ids, fields, '') : ids.map((id) => ({ id }));
  for (const r of rows) {
    const pids: number[] = [];
    for (const f of fields) {
      const v = r[f];
      const list = typeof v === 'number' ? [v] : Array.isArray(v) ? (v as number[]) : [];
      for (const p of list) if (p && !pids.includes(p)) pids.push(p);
    }
    out.set(r['id'] as number, pids);
  }
  return out;
}

/** models.py:137-153 `_mail_get_companies(default)`: the record's company_id, else the default. */
export async function mailGetCompanies(env: Environment, model: string, ids: readonly number[], dflt: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  const def = env.reg.model(model);
  if (!def.fields.has('company_id')) {
    for (const id of ids) out.set(id, dflt);
    return out;
  }
  for (const r of await env.model(model).read(ids, ['company_id'], '')) {
    const v = r['company_id'];
    out.set(r['id'] as number, typeof v === 'number' && v ? v : dflt);
  }
  return out;
}

/** mail_alias_domain.py:203-250 `_find_aliases` without alias domains (they refuse). */
async function findAliases(env: Environment, emails: readonly string[]): Promise<Set<string>> {
  const filtered = emails.filter((e) => e && e.indexOf('@') > 0 && e.indexOf('@') < e.length - 1);
  if (!filtered.length) return new Set();
  if ((await env.cr.query('SELECT 1 FROM mail_alias_domain LIMIT 1')).rows.length) throw new NotPorted('default recipients with alias domains (_find_aliases)');
  const param = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'mail.catchall.domain.allowed'")).rows[0]?.value ?? '';
  const allowed = new Set(param.split(',').filter(Boolean));
  const local = filtered.filter((e) => !allowed.size || allowed.has(e.split('@')[1]!)).map((e) => e.split('@')[0]!);
  const rows = (await env.cr.query<{ alias_full_name: string | null; alias_name: string | null; alias_incoming_local: boolean | null }>(
    `SELECT alias_full_name, alias_name, alias_incoming_local FROM mail_alias
      WHERE alias_full_name = ANY($1::text[]) OR (alias_name = ANY($2::text[]) AND alias_incoming_local IS TRUE)`, [filtered, local])).rows;
  const full = new Set(rows.filter((r) => !r.alias_incoming_local).map((r) => r.alias_full_name));
  const localNames = new Set(rows.filter((r) => r.alias_incoming_local).map((r) => r.alias_name));
  const out = new Set<string>();
  for (const e of filtered) {
    const [lp, domain] = [e.split('@')[0]!, e.split('@').slice(1).join('@')];
    if (full.has(e) || (localNames.has(lp) && (!allowed.size || allowed.has(domain)))) out.add(e);
  }
  return out;
}

export interface DefaultRecipients { email_cc: string; email_to: string; partner_ids: number[] }

/**
 * models.py:287-365 `_message_get_default_recipients(with_cc=False)` with `_message_add_default_recipients` (:238-285):
 * the record's customers with an email, public and banned (OdooBot, aliases) ones skipped. A record whose recipients
 * come from email fields alone (no customer with an email) refuses.
 */
export async function defaultRecipients(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, DefaultRecipients>> {
  refuseRecipientOverrides(model);
  const customers = await mailGetPartners(env, model, ids);
  const def = env.reg.model(model);
  // `_mail_get_primary_email` (:212-219) then the fallback fields (:262-273): what email_to_lst would hold
  const primary = PRIMARY_EMAIL[model] ?? (def.isMailThread ? 'email' : null);
  const emailFields = [...(primary && def.fields.has(primary) ? [primary] : []), ...['email_from', 'x_email_from', 'email', 'x_email', 'partner_email', 'email_normalized'].filter((f) => def.fields.has(f))];
  const emailValues = new Map<number, string | false>();
  if (emailFields.length) {
    for (const r of await env.model(model).read(ids, [...new Set(emailFields)], '')) {
      const first = emailFields.map((f) => r[f]).find((v) => typeof v === 'string' && v);
      emailValues.set(r['id'] as number, typeof first === 'string' ? first : false);
    }
  }
  const allPartners = [...new Set([...customers.values()].flat())];
  const partners = new Map((await env.cr.query<{ id: number; email: string | null; email_normalized: string | null }>(
    'SELECT id, email, email_normalized FROM res_partner WHERE id = ANY($1::int[])', [allPartners])).rows.map((p) => [p.id, p]));
  // res_partner.py `_compute_is_public`: a user of the partner (archived ones too) in base.group_public
  const publicIds = new Set((await env.cr.query<{ id: number }>(
    `SELECT DISTINCT u.partner_id AS id FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id
       JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid AND d.module = 'base' AND d.name = 'group_public'
      WHERE u.partner_id = ANY($1::int[])`, [allPartners])).rows.map((r) => r.id));
  // :306-319 banned: OdooBot's email unless an active partner has it, then the aliases among all the emails
  const ban = new Set<string>();
  const root = (await env.cr.query<{ e: string | null }>("SELECT p.email_normalized AS e FROM res_partner p JOIN ir_model_data d ON d.model = 'res.partner' AND d.res_id = p.id AND d.module = 'base' AND d.name = 'partner_root'")).rows[0]?.e ?? null;
  if (!(await env.model('res.partner').searchCount(cond('email_normalized', '=', root ?? false)))) {
    if (root) ban.add(root);
  }
  const allEmails = [...[...emailValues.values()].filter((v): v is string => Boolean(v)), ...allPartners.map((p) => partners.get(p)?.email_normalized).filter((e): e is string => Boolean(e))];
  for (const a of await findAliases(env, allEmails.map((e) => emailNormalize(e) ?? e.trim()))) ban.add(a);
  const out = new Map<number, DefaultRecipients>();
  for (const id of ids) {
    const cust = customers.get(id) ?? [];
    const all = cust.filter((p) => !publicIds.has(p) && !(partners.get(p)?.email_normalized && ban.has(partners.get(p)!.email_normalized!)));
    const valid = all.filter((p) => partners.get(p)?.email_normalized);
    // `_mail_defaults_to_email` is False for every model the overrides above leave (models.py:23)
    if (valid.length) { out.set(id, { email_cc: '', email_to: '', partner_ids: valid }); continue; }
    if (emailValues.get(id)) throw new NotPorted(`default recipients of ${model} from its email fields (email_split_and_format_normalize)`);
    out.set(id, { email_cc: '', email_to: '', partner_ids: all });
  }
  return out;
}

/** mail_template.py:681-695 `_parse_partner_list_ids` over the forms a template renders (ints, a list or tuple of them,
 *  comma-separated ids); other forms refuse. */
export function parsePartnerListIds(value: string): number[] {
  const s = value.trim();
  if (!s || s === 'False' || s === 'None' || s === '[]' || s === '()') return [];
  const lit = /^[[(]?\s*(\d+(?:\s*,\s*\d+)*)\s*,?\s*[\])]?$/.exec(s);
  if (lit && ((s.startsWith('[') && s.endsWith(']')) || (s.startsWith('(') && s.endsWith(')')) || !/[[\]()]/.test(s))) {
    return lit[1]!.split(',').map((x) => Number(x.trim())).filter((n) => n !== 0);
  }
  throw new NotPorted(`partner list ${JSON.stringify(value)} of a mail template (_parse_partner_list_ids)`);
}

/**
 * :338-409 `_generate_template_attachments`: the template's attachments; reports render through `_render_qweb_pdf`,
 * which needs a PDF engine for a report without a stored attachment (ir_actions_report.py:509-517). There is none
 * locally (as on the recorded Odoo: `get_pdf_engine_state` is 'install'): the UserError Odoo raises then. With an engine
 * (the deployed Worker) the attachment is not ported.
 */
export async function refuseReports(env: Environment, template: number): Promise<void> {
  const reports = (await env.cr.query<{ report_type: string; attachment: string | null; attachment_use: boolean | null }>(
    `SELECT r.report_type, r.attachment, r.attachment_use FROM mail_template_ir_actions_report_rel a
       JOIN ir_act_report_xml r ON r.id = a.ir_actions_report_id WHERE a.mail_template_id = $1 ORDER BY r.id`, [template])).rows;
  if (!reports.length) return;
  const first = reports[0]!;
  if (first.report_type !== 'qweb-html' && !first.report_type.startsWith('qweb-pdf')) throw new NotPorted(`template report of type ${first.report_type}`);
  if (first.attachment && first.attachment_use) throw new NotPorted('template report reused from a stored attachment (_retrieve_stream_from_attachment)');
  if (hasPdfEngine(env)) throw new NotPorted('template report rendered as a PDF attachment (_generate_template_attachments with a PDF engine)');
  throw new UserError('Unable to find the pdf engine on this system. The PDF can not be created.');
}

/**
 * Rendering as the user. mail.template renders unrestricted for every user (mail_template.py:22
 * `_unrestricted_rendering`, so mail_render_mixin.py:291-297 `_is_restricted` is False), in the user's environment.
 * Administrators (base.group_system) render as before; for another user each field read is checked as `fetch` does
 * (src/qweb/records.ts `RENDER_AS_USER`; a failing check refuses). Methods of the records that the template calls run as
 * ported, unchecked.
 */
async function asRenderer<T>(env: Environment, fn: () => Promise<T>): Promise<T> {
  if (env.su || await userHasGroup(env, 'base.group_system')) return fn();
  env.cache.set(RENDER_AS_USER, ((env.cache.get(RENDER_AS_USER) as number | undefined) ?? 0) + 1);
  try {
    return await fn();
  } finally {
    env.cache.set(RENDER_AS_USER, (env.cache.get(RENDER_AS_USER) as number) - 1);
  }
}

/** :754-778 `_render_lang`: the template's lang rendered, else the language of the record's first customer. */
export async function renderLang(env: Environment, tpl: TemplateRow, ids: readonly number[]): Promise<Map<number, string | false>> {
  const out = new Map<number, string | false>();
  if (tpl.lang) {
    for (const id of ids) out.set(id, await renderTemplateField(env, tpl.id, 'lang', id, null, false));
    return out;
  }
  return customerLangs(env, tpl.model, ids);
}

/** mail_render_mixin.py:770-775 `_render_lang` without a `lang` expression: the first customer's language. */
export async function customerLangs(env: Environment, model: string, ids: readonly number[]): Promise<Map<number, string | false>> {
  const out = new Map<number, string | false>();
  const customers = await mailGetPartners(env, model, ids);
  const langs = new Map((await env.cr.query<{ id: number; lang: string | null }>('SELECT id, lang FROM res_partner WHERE id = ANY($1::int[])',
    [[...customers.values()].map((c) => c[0]).filter((p): p is number => p !== undefined)])).rows.map((r) => [r.id, r.lang]));
  for (const id of ids) {
    const first = customers.get(id)?.[0];
    out.set(id, first === undefined ? false : (langs.get(first) ?? false));
  }
  return out;
}

/** :780-803 `_classify_per_lang`: the res_ids per language, in their order (a falsy language keeps the env's). */
export async function classifyPerLang(env: Environment, tpl: TemplateRow, ids: readonly number[]): Promise<Map<string | false, number[]>> {
  const preview = env.context['template_preview_lang'];
  if (preview) return new Map([[String(preview), [...ids]]]);
  const out = new Map<string | false, number[]>();
  for (const [id, lang] of await renderLang(env, tpl, ids)) {
    // '', False and None are distinct keys in Python, all rendered without a language: one group here
    const key = lang || false;
    const list = out.get(key) ?? [];
    list.push(id);
    out.set(key, list);
  }
  return out;
}

/** Fields `_generate_template` renders itself or through the sub-methods (:621-635). */
const SPECIFIC = new Set(['attachment_ids', 'email_cc', 'email_to', 'partner_to', 'partner_cc', 'report_template_ids', 'scheduled_date',
  'auto_delete', 'email_layout_xmlid', 'mail_server_id', 'model', 'res_id']);
const RENDERED = new Set<TemplateField>(['subject', 'body_html', 'email_from', 'reply_to', 'lang']);

export type Generated = Record<string, unknown>;

/**
 * :588-679 `_generate_template(res_ids, render_fields)` without suggested recipients nor partner creation: per
 * language, the rendered fields, the recipients, the scheduled date, the static values, then the attachments.
 * `attachment_ids` and `partner_ids` are lists of ids; reports raise (refuseReports).
 */
export async function generateTemplate(env: Environment, tpl: TemplateRow, ids: readonly number[], renderFields: readonly string[]): Promise<Map<number, Generated>> {
  return asRenderer(env, () => generate(env, tpl, ids, renderFields));
}

async function generate(env: Environment, tpl: TemplateRow, ids: readonly number[], renderFields: readonly string[]): Promise<Map<number, Generated>> {
  const fields = new Set(renderFields);
  const results = new Map<number, Generated>();
  const of = (id: number): Generated => {
    let v = results.get(id);
    if (!v) { v = {}; results.set(id, v); }
    return v;
  };
  for (const [lang, langIds] of await classifyPerLang(env, tpl, ids)) {
    const l = lang || null;
    for (const f of fields) {
      if (SPECIFIC.has(f)) continue;
      if (!RENDERED.has(f as TemplateField)) throw new NotPorted(`mail.template field ${f} rendered (_render_field)`);
      for (const id of langIds) of(id)[f] = await renderTemplateField(env, tpl.id, f as TemplateField, id, l, false);
    }
    // :411-531 `_generate_template_recipients`
    if (['email_cc', 'email_to', 'partner_to', 'partner_cc'].some((f) => fields.has(f))) {
      if (tpl.use_default_to && tpl.model) {
        for (const [id, r] of await defaultRecipients(env, tpl.model, langIds)) Object.assign(of(id), r);
      } else {
        for (const f of ['email_cc', 'email_to', 'partner_to', 'partner_cc'] as const) {
          if (!fields.has(f)) continue;
          for (const id of langIds) of(id)[f] = await renderTemplateField(env, tpl.id, f, id, l, false);
        }
      }
      // :510-529 partner_to / partner_cc into partner_ids / partner_cc_ids, existing partners only (sudo)
      const parsed = langIds.flatMap((id) => ['partner_to', 'partner_cc'].flatMap((f) => parsePartnerListIds(String(results.get(id)?.[f] ?? ''))));
      const existing = new Set(parsed.length ? (await env.cr.query<{ id: number }>('SELECT id FROM res_partner WHERE id = ANY($1::int[])', [parsed])).rows.map((r) => r.id) : []);
      for (const id of langIds) {
        const v = of(id);
        for (const [src, dst] of [['partner_to', 'partner_ids'], ['partner_cc', 'partner_cc_ids']] as const) {
          const raw = v[src];
          delete v[src];
          if (!raw) continue;
          // `set(...) & existing_pids`: a set, iterated in CPython's order (small ints: ascending)
          const pids = [...new Set(parsePartnerListIds(String(raw)))].filter((p) => existing.has(p)).sort((a, b) => a - b);
          v[dst] = [...((v[dst] as number[] | undefined) ?? []), ...pids];
        }
      }
    }
    // :533-553 `_generate_template_scheduled_date`
    if (fields.has('scheduled_date')) {
      const { parseScheduledDatetime } = await import('./mail_mail_create');
      for (const id of langIds) of(id)['scheduled_date'] = parseScheduledDatetime(await renderTemplateField(env, tpl.id, 'scheduled_date', id, l, false));
    }
    // :555-586 static values
    for (const id of langIds) {
      const v = of(id);
      if (fields.has('auto_delete')) v['auto_delete'] = tpl.auto_delete;
      if (fields.has('email_layout_xmlid')) v['email_layout_xmlid'] = tpl.email_layout_xmlid ?? false;
      if (fields.has('mail_server_id')) v['mail_server_id'] = tpl.mail_server_id ?? false;
      if (fields.has('model')) v['model'] = tpl.model;
      if (fields.has('res_id')) v['res_id'] = id || false;
    }
    // :338-409 attachments
    if (fields.has('attachment_ids') || fields.has('report_template_ids')) {
      const atts = fields.has('attachment_ids') ? ((await env.model('mail.template').read([tpl.id], ['attachment_ids'], ''))[0]?.['attachment_ids'] as number[] ?? []) : [];
      if (fields.has('report_template_ids')) await refuseReports(env, tpl.id);
      for (const id of langIds) if (fields.has('attachment_ids')) of(id)['attachment_ids'] = [...atts];
      // :398-407 `_process_attachments_for_template_post`: only account_edi overrides it
      if ((await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = 'account_edi' AND state = 'installed'")).rows.length && tpl.model === 'account.move') {
        throw new NotPorted('EDI attachments of an invoice template (account_edi _process_attachments_for_template_post)');
      }
    }
  }
  return results;
}

/** The `message` of an encapsulated body (mail_render_mixin.py:211-217): a new mail.message with body, model, res_id. */
class LayoutMessage extends PyObject {
  constructor(private readonly env: Environment, private readonly body: string, private readonly model: string | null, private readonly resId: number | null) {
    super();
  }
  pyGetAttr(name: string): unknown {
    switch (name) {
      case 'body': return new Markup(this.body);
      // mail_message.py:318-324 `_compute_preview`
      case 'preview': {
        const p = messagePreview(this.body);
        if (p === null) throw new NotPorted('preview of an encapsulated body');
        return p;
      }
      // :354-362 `_compute_record_name`: the record's display name as superuser
      case 'record_name': return this.model && this.resId
        ? this.env.sudo().model(this.model).displayName([this.resId]).then((m) => m.get(this.resId!) ?? false) : false;
      case 'model': return this.model ?? false;
      case 'res_id': return this.resId ?? false;
      default: throw new NotPorted(`mail.message.${name} of an encapsulated body`);
    }
  }
  override pyToString(): string { return 'mail.message(NewId,)'; }
}

export interface EncapsulateContext {
  readonly company: number;
  readonly modelDescription: string | false;
}

/**
 * mail_render_mixin.py:194-262 `_render_encapsulate(layout_xmlid, html, add_context, context_record)` without a
 * message, subtype or subtitles in the context: the layout view rendered from the database in `env`'s language.
 */
export async function renderEncapsulate(env: Environment, layout: string, html: string, add: EncapsulateContext, record: { model: string; id: number } | null): Promise<string> {
  const recordName = record ? ((await env.model(record.model).displayName([record.id])).get(record.id) ?? false) : '';
  const ctx = env.context;
  // :231-235 `self.env.context.get('email_notification_subtitles', [record_name])`, each `str()`: a lazy term in the
  // layout's language (translate.py LazyGettext.__str__ finds this method's `self.env.lang`)
  const given = ctx['email_notification_subtitles'];
  let subtitles: string[] = [String(recordName)];
  if (given !== undefined) {
    if (!Array.isArray(given)) throw new NotPorted('_render_encapsulate with email_notification_subtitles that is not a list');
    subtitles = given.map((sub: unknown) => {
      if (typeof sub === 'string') return sub;
      if (sub instanceof LazyTerm) return translate(env, sub.source, sub.module);
      throw new NotPorted(`_render_encapsulate with a subtitle of type ${typeof sub}`);
    });
  }
  const highlight = ctx['email_notification_subtitles_highlight_index'] ?? 0;
  if (typeof highlight !== 'number') throw new NotPorted('_render_encapsulate with a subtitle highlight index that is not a number');
  const values: Record<string, unknown> = {
    body: new Markup(html),
    record: record ? new PyRecords(env, record.model, [record.id]) : false,
    record_name: recordName,
    company: new PyRecords(env, 'res.company', [add.company]),
    model_description: add.modelDescription,
    message: new LayoutMessage(env, html, record?.model ?? null, record?.id ?? null),
    // :218-221 no subtype
    is_discussion: false,
    subtype_internal: false,
    subtype: new PyRecords(env.sudo(), 'mail.message.subtype', []),
    subtitles,
    subtitles_highlight_index: highlight,
    author_user: false,
    email_add_signature: false,
    lang: env.lang ?? false,
    signature: '',
    show_unfollow: false,
    website_url: '',
    button_access: false,
    has_button_access: false,
    email_notification_force_header: ctx['email_notification_force_header'] ?? false,
    email_notification_force_footer: ctx['email_notification_force_footer'] ?? false,
    email_notification_allow_header: ctx['email_notification_allow_header'] ?? true,
    email_notification_allow_footer: ctx['email_notification_allow_footer'] ?? false,
    is_html_empty: isHtmlEmpty,
  };
  // :259 `ir.qweb._render(layout_xmlid, template_ctx, minimal_qcontext=True)`: `lang` stays `self.env.lang`
  const out = await renderQweb(env, layout, values, true);
  const base = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? '';
  return replaceLocalLinks(out, base);
}

/**
 * sale_order.py:2726-2741 `_get_product_documents`, which the quotation templates call: the documents of the lines'
 * products and templates (`product_document_ids`, active ones, res_model the product's model) shown on a quotation, or
 * on an order once confirmed. None: the empty recordset; any refuses (their `sorted()` and portal links).
 */
registerPyMethod('sale.order', '_get_product_documents', async (recs) => {
  const id = recs.ensureOne();
  const found = (await recs.env.cr.query(
    `SELECT 1 FROM product_document d JOIN ir_attachment a ON a.id = d.ir_attachment_id JOIN sale_order o ON o.id = $1
      WHERE d.active IS TRUE AND (d.attached_on_sale = 'quotation' OR (o.state = 'sale' AND d.attached_on_sale = 'sale_order'))
        AND ((a.res_model = 'product.product' AND a.res_id IN (SELECT product_id FROM sale_order_line WHERE order_id = $1 AND product_id IS NOT NULL))
          OR (a.res_model = 'product.template' AND a.res_id IN (SELECT p.product_tmpl_id FROM sale_order_line l JOIN product_product p ON p.id = l.product_id WHERE l.order_id = $1)))
      LIMIT 1`, [id])).rows.length;
  if (found) throw new NotPorted('product documents in a sale mail template (_get_product_documents)');
  return new PyRecords(recs.env, 'product.document', []);
});

/** `ir.model._get(model).with_context(lang=lang).display_name`. */
export async function modelDescription(env: Environment, model: string): Promise<string | false> {
  const id = (await env.cr.query<{ id: number }>('SELECT id FROM ir_model WHERE model = $1', [model])).rows[0]?.id;
  if (id === undefined) return false;
  return (await env.sudo().model('ir.model').displayName([id])).get(id) ?? false;
}

async function refuseWebsite(env: Environment): Promise<void> {
  // models.py:3327 `get_base_url`: website overrides it per record (website/models/ir_model.py:9)
  if ((await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = 'website' AND state = 'installed'")).rows.length) {
    throw new NotPorted('mail template links with website base URLs (get_base_url overrides)');
  }
}

export interface SendOptions {
  readonly forceSend?: boolean;
  readonly emailValues?: Readonly<Record<string, unknown>> | null;
  readonly emailLayoutXmlid?: string | false;
}

const SEND_FIELDS = ['attachment_ids', 'auto_delete', 'body_html', 'email_cc', 'email_from', 'email_to', 'mail_server_id', 'model', 'partner_to',
  'partner_cc', 'reply_to', 'report_template_ids', 'res_id', 'scheduled_date', 'subject'];

/** :729-858 `send_mail_batch`: the mail.mail ids, one per record. */
export async function sendMailBatch(env: Environment, templateId: number, resIds: readonly number[], opts: SendOptions = {}): Promise<number[]> {
  const tpl = await templateRow(env, templateId);
  await refuseWebsite(env);
  if (!env.su) await env.model('mail.template').checkAccess([templateId], 'read');
  // :701-703 `_send_check_access`
  const ids = resIds.filter((id) => id);
  if (ids.length !== resIds.length) throw new NotPorted('send_mail without a record (res_id False)');
  await env.model(tpl.model).checkAccess(ids, 'read');
  const layout = opts.emailLayoutXmlid || tpl.email_layout_xmlid;
  const generated = await generateTemplate(env, tpl, ids, SEND_FIELDS);
  let langs = new Map<number, string | false>();
  let companies = new Map<number, number>();
  if (layout) {
    if (tpl.lang) langs = await renderLang(env, tpl, ids);
    companies = await mailGetCompanies(env, tpl.model, ids, await env.company());
  }
  const valuesList: Record<string, unknown>[] = [];
  for (const id of ids) {
    const values = { ...generated.get(id)! };
    values['recipient_ids'] = ((values['partner_ids'] as number[] | undefined) ?? []).map((p) => [4, p]);
    values['recipient_cc_ids'] = ((values['partner_cc_ids'] as number[] | undefined) ?? []).map((p) => [4, p]);
    values['attachment_ids'] = ((values['attachment_ids'] as number[] | undefined) ?? []).map((a) => [4, a]);
    Object.assign(values, opts.emailValues ?? {});
    delete values['attachments'];
    if ('email_from' in values && !values['email_from']) delete values['email_from'];
    if (!layout) {
      values['body'] = values['body_html'];
    } else {
      const lang = langs.get(id) || env.lang;
      const envLang = lang ? env.withContext({ ...env.context, lang }) : env;
      values['body_html'] = await renderEncapsulate(envLang, layout, String(values['body_html'] ?? ''), {
        company: companies.get(id) ?? await env.company(), modelDescription: await modelDescription(envLang, tpl.model),
      }, { model: tpl.model, id });
      values['body'] = values['body_html'];
    }
    valuesList.push(values);
  }
  const mails = await create(env.sudo(), 'mail.mail', valuesList);
  if (opts.forceSend) throw new NotPorted('send_mail with force_send (mail.mail send)');
  return mails;
}

/**
 * :729-858 `send_mail_batch(res_ids, force_send=False, raise_exception=False, email_values=None, email_layout_xmlid=False)`:
 * the mail.mail ids (compiled code gets them as `mail.mail` records, compiler/runtime/records.ts). The template renders
 * with the caller's context as `ctx` (lunch.supplier `_send_auto_email`: the order of the day in `order`, `lines`).
 * More records than `mail.batch_size` (several chunks) refuse.
 */
registerMethod('mail.template', 'send_mail_batch', async (env0, ids, args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted('send_mail_batch on several templates (Expected singleton)');
  const names = ['res_ids', 'force_send', 'raise_exception', 'email_values', 'email_layout_xmlid'];
  const a: Record<string, unknown> = {};
  names.forEach((n, i) => { if (i < args.length) a[n] = args[i]; });
  for (const [k, v] of Object.entries(kwargs0)) if (k !== 'context') a[k] = v;
  const resIds = a['res_ids'];
  if (!Array.isArray(resIds) || !resIds.every((x) => typeof x === 'number')) throw new NotPorted(`send_mail_batch with res_ids ${JSON.stringify(resIds)}`);
  // :742 `get_int('mail.batch_size') or 50`: one chunk only
  const size = Number((await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'mail.batch_size'")).rows[0]?.value ?? 0) || 50;
  if (resIds.length > size) throw new NotPorted(`send_mail_batch of ${resIds.length} records, more than mail.batch_size (${size})`);
  const ev = a['email_values'];
  if (ev !== undefined && ev !== null && ev !== false && (typeof ev !== 'object' || Array.isArray(ev))) throw new NotPorted('send_mail_batch email_values other than a dict');
  const layout = a['email_layout_xmlid'];
  return sendMailBatch(env, ids[0]!, resIds as number[], {
    forceSend: Boolean(a['force_send']), emailValues: (ev || null) as Record<string, unknown> | null,
    emailLayoutXmlid: typeof layout === 'string' ? layout : false,
  });
}, { apiModel: false });

/** :705-727 `send_mail(res_id, force_send=False, raise_exception=False, email_values=None, email_layout_xmlid=False)`. */
registerMethod('mail.template', 'send_mail', async (env0, ids, args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted('send_mail on several templates (Expected singleton)');
  const names = ['res_id', 'force_send', 'raise_exception', 'email_values', 'email_layout_xmlid'];
  const a: Record<string, unknown> = {};
  names.forEach((n, i) => { if (i < args.length) a[n] = args[i]; });
  for (const [k, v] of Object.entries(kwargs0)) if (k !== 'context') a[k] = v;
  const resId = a['res_id'];
  if (typeof resId !== 'number') throw new NotPorted(`send_mail with res_id ${JSON.stringify(resId)}`);
  const ev = a['email_values'];
  if (ev !== undefined && ev !== null && ev !== false && (typeof ev !== 'object' || Array.isArray(ev))) throw new NotPorted('send_mail email_values other than a dict');
  const layout = a['email_layout_xmlid'];
  const [mail] = await sendMailBatch(env, ids[0]!, [resId], {
    forceSend: Boolean(a['force_send']), emailValues: (ev || null) as Record<string, unknown> | null,
    emailLayoutXmlid: typeof layout === 'string' ? layout : false,
  });
  return mail;
}, { apiModel: false });
