/**
 * `mail.compose.message` (mail/wizard/mail_compose_message.py):
 * - comment mode (mono and batch, with or without a template, including full composer marker, suggested recipients,
 *   cc partners, custom/edited body, template of another model, empty email_from, composer_force_res_ids, res_domain)
 * - mass_mail mode (mono and batch, with or without a template: dynamic rendering, default recipients, blacklist /
 *   missing / invalid / duplicate email state processing, mail.mail + mail.notification creation, force_send).
 *
 * Used by the web client's composer (`action_send_mail`) and by `message_post_with_source` (src/mail/post_source.ts).
 */
import { createHash } from 'node:crypto';
import { AccessError, NotPorted, UserError } from '../errors';
import { readFile, writeFile } from '../filestore';
import { EMAIL_OUTGOING_XML } from '../orm/html_output';
import { requestOfCursor } from '../http/context';
import { registerMethod } from '../http/methods';
import { createBinaryAttachment } from '../models/account_move_send_mail';
import { defineComputes } from '../models/tail_util';
import { textwrapShorten, translate } from '../models/util';
import { create } from '../orm/create';
import { cond, parseDomain } from '../orm/domain';
import { hasGroup, userInfo } from '../orm/env';
import { DbRec, NOT_ASSIGNED, type Rec } from '../orm/recompute';
import type { Environment } from '../orm/types';
import { registerOverrides, write } from '../orm/write';
import { htmlSanitize } from '../orm/html_sanitize';
import { sanitizeHtml } from '../orm/write_values';
import { evalPyExpr, parsePyExpr } from '../orm/pyexpr';
import { evalExprAsync } from '../pyexpr';
import { isHtmlEmpty } from '../qweb/helpers';
import { renderInlineForRecord, renderQwebBodyForRecord } from '../qweb/mail_render';
import { PyRecords } from '../qweb/records';
import { hasPdfEngine } from '../report/engine';
import { userFlags } from '../session/user';
import { envFor } from '../web/common';
import { checkImagePostprocess, indexContent, plainXml } from './attachment';
import { messageSubscribe } from './followers';
import { emailNormalize, formatAddr, insertMessages, partnerEmailFormatted, replyToDefault, trackingMessageId, xmlid } from './message';
import { messagePostAfterHook } from './move_import';
import { notifyFailure, notifyThread, smtpConnectFailure } from './notify';
import { partnerFindFromEmails } from './partner_find';
import { leadPartnerFromRecipients } from './post';
import { suggested as suggestedPartnerRecipients } from './thread';
import { emailSplitTuples, flatParent, isGenericThread, permissionOn, postAccessOf, suggestedRecipients, suggestedSubjectFor } from './thread_generic';
import { customerLangs, defaultRecipients, generateTemplate, mailGetCompanies, mailGetPartners, renderLang, templateRow, type TemplateRow } from './template_send';

const MODEL = 'mail.compose.message';

const m2o = (v: unknown): number | null => (typeof v === 'number' && v ? v : null);

/** mail/tools/parser.py `parse_res_ids`: parse a list/tuple/string of integer record ids. */
function parseResIdList(raw: unknown): number[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: number[] = [];
    for (const item of raw) {
      const n = typeof item === 'number' ? item : typeof item === 'string' && /^\d+$/.test(item.trim()) ? Number(item.trim()) : NaN;
      if (!Number.isInteger(n)) throw new NotPorted(`mail.compose.message.res_ids item ${JSON.stringify(item)}`);
      out.push(n);
    }
    return out;
  }
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '[]' || s === '()') return [];
    const m = /^[[(]\s*(\d+(?:\s*,\s*\d+)*)\s*,?\s*[\])]$/.exec(s);
    if (!m) throw new NotPorted(`mail.compose.message.res_ids ${raw}`);
    return m[1]!.split(',').map((x) => Number(x.trim()));
  }
  throw new NotPorted(`mail.compose.message.res_ids of type ${typeof raw}`);
}

/** mail_compose_message.py:1698-1717 `_evaluate_res_ids`: composer_force_res_ids -> res_ids -> active_ids. */
function resIds(env: Environment, value: unknown): number[] {
  const forced = env.context['composer_force_res_ids'];
  if (forced && (!Array.isArray(forced) || forced.length > 0)) return parseResIdList(forced);
  if (value && (!Array.isArray(value) || value.length > 0)) return parseResIdList(value);
  const active = env.context['active_ids'];
  if (active && (!Array.isArray(active) || active.length > 0)) return parseResIdList(active);
  return [];
}

/** Parse `res_domain` (a Python list/tuple string or array) and search matching ids on `model`. */
async function evaluateResDomain(env: Environment, model: string, resDomain: unknown): Promise<number[]> {
  if (!resDomain) return [];
  const raw = typeof resDomain === 'string'
    ? evalPyExpr(parsePyExpr(resDomain.trim()), (path) => { throw new NotPorted(`mail.compose.message.res_domain var ${path.join('.')}`); })
    : resDomain;
  return env.model(model).search(parseDomain(raw, true));
}

interface ComposerState {
  readonly compositionMode: 'comment' | 'mass_mail';
  readonly model: string | null;
  readonly ids: number[];
  readonly hasDomain: boolean;
  readonly isBatch: boolean;
  readonly isMonoComment: boolean;
  readonly templateId: number | null;
  readonly parentId: number | null;
}

async function composerState(env: Environment, rec: Rec): Promise<ComposerState> {
  const modeRaw = await rec.get('composition_mode');
  const compositionMode: 'comment' | 'mass_mail' = modeRaw === 'mass_mail' ? 'mass_mail' : 'comment';
  const modelRaw = await rec.get('model');
  const model = typeof modelRaw === 'string' && modelRaw ? modelRaw : null;
  const ids = resIds(env, await rec.get('res_ids'));
  const hasDomain = Boolean(await rec.get('res_domain'));
  const isBatch = hasDomain || ids.length > 1;
  const isMonoComment = compositionMode === 'comment' && !isBatch;
  const templateId = m2o(await rec.get('template_id'));
  const parentId = m2o(await rec.get('parent_id'));
  return { compositionMode, model, ids, hasDomain, isBatch, isMonoComment, templateId, parentId };
}

/** The template's raw value of a field in the env's language (`self.template_id[fname]`). */
async function templateValue(env: Environment, tpl: TemplateRow, fname: string): Promise<unknown> {
  return new DbRec(env, env.reg.model('mail.template'), tpl.id).get(fname);
}

/**
 * :1719-1755 `_set_value_from_template(fname)`:
 * - When the template's value is empty (or empty html for `body_html`), returns undefined (composer keeps its own value).
 * - In monorecord comment mode, renders the field for `ids[0] || 0` through `generateTemplate` (which renders on `tpl.model`).
 * - In batch comment or mass_mail mode, returns the raw (unrendered) template value.
 */
async function fromTemplate(env: Environment, st: ComposerState, tpl: TemplateRow, fname: string): Promise<unknown> {
  const resId = st.ids[0] ?? 0;
  const key = `composer.render:${tpl.id}:${st.isMonoComment ? resId : 'raw'}:${fname}:${env.uid}:${env.lang ?? ''}`;
  if (env.cache.has(key)) return env.cache.get(key);
  let raw = await templateValue(env, tpl, fname);
  if (raw && fname === 'body_html' && isHtmlEmpty(String(raw))) raw = false;
  let value: unknown = undefined;
  if (raw) {
    if (st.isMonoComment) {
      value = (await generateTemplate(env, tpl, [resId], [fname])).get(resId)![fname];
    } else {
      value = raw;
    }
  }
  env.cache.set(key, value);
  return value;
}

/** The composer's `body` field: sanitize 'email_outgoing' with sanitize_style (mail_compose_message.py:96-100,
 *  fields_textual.py:628-635), in this Odoo commit's output method (orm/html_output.ts). */
const composerBody = (html: string): string => htmlSanitize(html, {
  sanitizeTags: false, sanitizeAttributes: false, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false,
  xmlOutput: EMAIL_OUTGOING_XML,
});

/**
 * mail_thread.py:3104-3125 `_message_compute_author(None, email_from)` through `_partner_find_from_emails_single(
 * [email_from], no_create=True)` on the empty mail.thread (:2057-2165, res_partner.py `_find_or_create_from_emails`):
 * the partners of the normalized email (as the user, id order), sorted by the user's partner first, then internal
 * ones, partners with users, without company, the exact formatted email, without company; null when none.
 */
export async function partnerFromEmail(env: Environment, email: string): Promise<number | null> {
  // tools/mail.py:1111 `parse_contact_from_email`: the first address of the value, normalized
  const first = emailSplitTuples(email)[0];
  const normalized = first ? emailNormalize(first[1]) : null;
  if (!normalized) return null;
  const ids = await env.model('res.partner').search(cond('email_normalized', '=', normalized), { order: 'id ASC' });
  if (!ids.length) return null;
  const self = (await userInfo(env)).partnerId;
  const rows = new Map((await env.cr.query<{ id: number; partner_share: boolean | null; company_id: number | null; name: string | null; email: string | null; users: number }>(
    `SELECT p.id, p.partner_share, p.company_id, p.name, p.email, (SELECT count(*) FROM res_users u WHERE u.partner_id = p.id)::int AS users
       FROM res_partner p WHERE p.id = ANY($1::int[])`, [ids])).rows.map((r) => [r.id, r]));
  const key = async (id: number): Promise<number[]> => {
    const p = rows.get(id)!;
    const formatted = p.email ? (emailNormalize(p.email) ? formatAddr(p.name || 'False', emailNormalize(p.email)!) : p.email) : false;
    // (user, follower: none on the empty thread, internal, has users (archived ones too: active_test False), company ==
    // the record's: none, exact email, no company)
    return [id === self ? 1 : 0, 0, p.partner_share ? 0 : 1, p.users ? 1 : 0, p.company_id === null ? 1 : 0, formatted === email ? 1 : 0, p.company_id === null ? 1 : 0];
  };
  const keyed = await Promise.all(ids.map(async (id) => ({ id, k: await key(id) })));
  // sorted(reverse=True) keeps equal keys in their search order
  keyed.sort((a, b) => {
    for (let i = 0; i < a.k.length; i++) if (a.k[i] !== b.k[i]) return b.k[i]! - a.k[i]!;
    return 0;
  });
  return keyed[0]!.id;
}

interface Authorship { readonly emailFrom: string | false; readonly author: number | typeof NOT_ASSIGNED }

/** :380-426 `_compute_authorship` in all modes (with/without template, mono/batch, comment/mass_mail, empty email_from). */
async function authorship(env: Environment, rec: Rec): Promise<Authorship> {
  const st = await composerState(env, rec);
  const key = `composer.author:${st.templateId ?? 'none'}:${st.compositionMode}:${st.isBatch ? 'b' : (st.ids[0] ?? 0)}:${env.uid}:${env.context['default_email_from'] ?? ''}`;
  const known = env.cache.get(key) as Authorship | undefined;
  if (known) return known;
  const self = await userInfo(env);
  const renderingMode = st.isMonoComment;
  let emailFrom: string | false = false;
  let updatedAuthor: number | null = null;

  if (st.templateId !== null) {
    const tpl = await templateRow(env, st.templateId);
    const tplEmailFrom = await templateValue(env, tpl, 'email_from');
    if (tplEmailFrom) {
      const rendered = await fromTemplate(env, st, tpl, 'email_from');
      emailFrom = typeof rendered === 'string' ? rendered : false;
    } else {
      emailFrom = await partnerEmailFormatted(env, self.partnerId);
    }
  } else {
    const defFrom = env.context['default_email_from'];
    if (typeof defFrom === 'string' && defFrom) {
      emailFrom = defFrom;
    } else {
      emailFrom = await partnerEmailFormatted(env, self.partnerId);
      updatedAuthor = self.partnerId;
    }
  }

  if (emailFrom && renderingMode && !updatedAuthor) {
    const found = await partnerFromEmail(env.withContext({ ...env.context, active_test: false }), emailFrom);
    updatedAuthor = found ?? self.partnerId;
  }
  if (!renderingMode || st.templateId === null) {
    updatedAuthor = self.partnerId;
  }
  const result: Authorship = { emailFrom, author: updatedAuthor ?? NOT_ASSIGNED };
  env.cache.set(key, result);
  return result;
}

/** Suggested recipients for a single record `(model, resId)`, matching `_message_get_suggested_recipients_batch`. */
async function suggestedForModel(env: Environment, model: string, resId: number) {
  if (model === 'res.partner') return suggestedPartnerRecipients(env, resId);
  if (isGenericThread(model)) return suggestedRecipients(env, model, resId);
  // Non-thread or unlisted models: fall back to defaultRecipients (partner_ids only)
  const d = (await defaultRecipients(env, model, [resId])).get(resId);
  return (d?.partner_ids ?? []).map((pid) => ({
    email: false as const, name: false as const, partner_id: pid, create_values: {}, recipient_type: 'to' as const,
  }));
}

/**
 * Resolve template recipients for one record `(tpl, resId)` with `allow_suggested` and `find_or_create_partners`
 * (mail_template.py:455-530, mail_compose_message.py:1540-1593).
 */
async function templateRecipientsForRecord(
  env: Environment,
  tpl: TemplateRow,
  resId: number,
  allowSuggested: boolean,
  findOrCreatePartners: boolean,
): Promise<{ to: number[]; cc: number[]; emailTo: string; emailCc: string }> {
  let to: number[] = [];
  let cc: number[] = [];
  let emailTo = '';
  let emailCc = '';

  if (tpl.use_default_to && tpl.model) {
    if (allowSuggested && resId) {
      const list = await suggestedForModel(env, tpl.model, resId);
      to = list.filter((r) => r.partner_id && r.recipient_type === 'to').map((r) => Number(r.partner_id));
      cc = list.filter((r) => r.partner_id && r.recipient_type === 'cc').map((r) => Number(r.partner_id));
      const toEmails = list.filter((r) => !r.partner_id && r.recipient_type === 'to' && r.email)
        .map((r) => formatAddr(String(r.name || ''), String(r.email)));
      const ccEmails = list.filter((r) => !r.partner_id && r.recipient_type === 'cc' && r.email)
        .map((r) => formatAddr(String(r.name || ''), String(r.email)));
      emailTo = toEmails.join(', ');
      emailCc = ccEmails.join(', ');
    } else if (resId) {
      const v = (await generateTemplate(env, tpl, [resId], ['email_cc', 'email_to', 'partner_to', 'partner_cc'])).get(resId)!;
      to = [...((v['partner_ids'] as number[] | undefined) ?? [])];
      cc = [...((v['partner_cc_ids'] as number[] | undefined) ?? [])];
      emailTo = String(v['email_to'] ?? '');
      emailCc = String(v['email_cc'] ?? '');
    }
  } else if (resId) {
    const v = (await generateTemplate(env, tpl, [resId], ['email_cc', 'email_to', 'partner_to', 'partner_cc'])).get(resId)!;
    to = [...((v['partner_ids'] as number[] | undefined) ?? [])];
    cc = [...((v['partner_cc_ids'] as number[] | undefined) ?? [])];
    emailTo = String(v['email_to'] ?? '');
    emailCc = String(v['email_cc'] ?? '');
  }

  if (findOrCreatePartners && (emailTo || emailCc)) {
    const toList = emailSplitTuples(emailTo).map(([, addr]) => addr).filter(Boolean);
    const ccList = emailSplitTuples(emailCc).map(([, addr]) => addr).filter(Boolean);
    const ccNorm = new Set(ccList.map((e) => emailNormalize(e)).filter((e): e is string => e !== null));
    const allFound = await partnerFindFromEmails(env, tpl.model, resId || null, [...toList, ...ccList], false);
    if (allFound.length) {
      const pRows = (await env.cr.query<{ id: number; email_normalized: string | null }>(
        'SELECT id, email_normalized FROM res_partner WHERE id = ANY($1::int[])', [allFound])).rows;
      const byEmail = new Map(pRows.map((p) => [p.email_normalized, p.id]));
      const foundSet = new Set(allFound);
      const foundCc: number[] = [];
      for (const e of ccNorm) {
        const pid = byEmail.get(e);
        if (pid !== undefined && foundSet.has(pid)) foundCc.push(pid);
      }
      const foundCcSet = new Set(foundCc);
      for (const pid of foundCc) if (!cc.includes(pid)) cc.push(pid);
      for (const pid of allFound) if (!foundCcSet.has(pid) && !to.includes(pid)) to.push(pid);
    }
    emailTo = '';
    emailCc = '';
  }

  return { to, cc, emailTo, emailCc };
}

/** :574-610 `_compute_recipient_partners` with `_generate_template_for_composer` (:1540-1597, find_or_create_partners). */
async function recipients(env: Environment, rec: Rec): Promise<{ to: number[] | undefined; cc: number[] | undefined }> {
  const st = await composerState(env, rec);
  if (st.templateId !== null && st.isMonoComment) {
    const tpl = await templateRow(env, st.templateId);
    const current = await rec.get('partner_ids');
    if (tpl.use_default_to && Array.isArray(current) && current.length) return { to: undefined, cc: undefined };
    const messageType = await rec.get('message_type');
    const isLog = m2o(await rec.get('subtype_id')) === await xmlid(env, 'mail.mt_note');
    const allowSuggested = messageType === 'comment' && !isLog;
    const resId = st.ids[0] ?? 0;
    const r = await templateRecipientsForRecord(env, tpl, resId, allowSuggested, true);
    return { to: r.to.length ? r.to : undefined, cc: r.cc.length ? r.cc : undefined };
  }
  if (st.parentId !== null && st.compositionMode === 'comment') {
    const to = (await env.cr.query<{ id: number }>('SELECT res_partner_id AS id FROM mail_message_res_partner_rel WHERE mail_message_id = $1 ORDER BY res_partner_id', [st.parentId])).rows.map((r) => r.id);
    const cc = (await env.cr.query<{ id: number }>('SELECT res_partner_id AS id FROM mail_message_res_partner_cc_rel WHERE mail_message_id = $1 ORDER BY res_partner_id', [st.parentId])).rows.map((r) => r.id);
    return { to, cc };
  }
  if (st.templateId === null) return { to: [], cc: [] };
  // Batch or mass_mail with a template: recipients are computed at sending time
  return { to: undefined, cc: undefined };
}

/**
 * `ir.attachment.copy({'res_model': resModel, 'res_id': resId})` (ir_attachment.py:899-958):
 * copies stored fields (`name`, `description`, `res_field`, `company_id`, `type`, `url`, `public`,
 * `access_token`, `mimetype`, `original_id`) and re-stores binary content in filestore.
 */
async function copyAttachment(env: Environment, attId: number, resModel: string, resId: number): Promise<number> {
  const row = (await env.cr.query<{
    name: string; description: string | null; res_field: string | null; company_id: number | null;
    type: string; url: string | null; public: boolean | null; access_token: string | null;
    mimetype: string | null; original_id: number | null; store_fname: string | null; db_datas: Buffer | null;
    file_size: number | null; checksum: string | null; index_content: string | null;
  }>(
    `SELECT name, description, res_field, company_id, type, url, public, access_token, mimetype,
            original_id, store_fname, db_datas, file_size, checksum, index_content
       FROM ir_attachment WHERE id = $1`, [attId])).rows[0];
  if (!row) throw new NotPorted(`copying missing ir.attachment ${attId}`);
  // create :921 `_check_contents` (:532-559) of the copy's values: `_compute_mimetype` keeps the copied mimetype, an
  // html/xml-like one becomes text/plain for a user without write access on ir.ui.view (`sudo(False)`: the real user)
  const mimetype = await plainXml(env.withUser(env.uid), row.mimetype ?? 'application/octet-stream');
  let fileSize: number | null = row.file_size;
  let checksum: string | null = row.checksum;
  let storeFname: string | null = row.store_fname;
  let idxContent: string | null = row.index_content;
  if (row.type === 'binary') {
    const ctx = requestOfCursor(env.cr);
    if (ctx === null || ctx.db === null) throw new NotPorted('copying binary attachment outside a request');
    if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) {
      throw new NotPorted('database attachment storage on attachment copy');
    }
    const data = row.store_fname
      ? await readFile(ctx.env, ctx.db, row.store_fname)
      : row.db_datas
        ? new Uint8Array(row.db_datas)
        : new Uint8Array();
    if (data === null) throw new NotPorted(`copying attachment ${attId} missing from filestore`);
    if (!env.context['image_no_postprocess']) await checkImagePostprocess(env, mimetype, data); // :556-557
    if (data.length > 0) {
      checksum = createHash('sha1').update(data).digest('hex');
      storeFname = `${checksum.slice(0, 2)}/${checksum}`;
      fileSize = data.length;
      idxContent = indexContent(data, mimetype);
      await writeFile(ctx.env, ctx.db, storeFname, data);
    } else {
      checksum = null;
      storeFname = null;
      fileSize = null;
      idxContent = null;
    }
  }
  const inserted = (await env.cr.query<{ id: number }>(
    `INSERT INTO ir_attachment (name, description, res_model, res_id, res_field, company_id, type, url, public,
       access_token, mimetype, original_id, file_size, checksum, store_fname, index_content,
       create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $17, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
     RETURNING id`,
    [
      row.name, row.description, resModel, resId, row.res_field, row.company_id, row.type, row.url,
      Boolean(row.public), row.access_token, mimetype, row.original_id, fileSize, checksum, storeFname, idxContent,
      env.uid,
    ])).rows[0]!;
  return inserted.id;
}

/**
 * `mail_thread.py:2511-2524` `_process_attachments_for_post` for existing `attachment_ids`:
 * re-parents pending composer/scheduled attachments created by the current user to `(targetModel, targetResId)`,
 * and restricts non-internal users to only those attachments.
 */
async function processAttachmentsForPost(
  env: Environment,
  attachmentIds: readonly number[],
  targetModel: string,
  targetResId: number,
): Promise<number[]> {
  if (!attachmentIds.length) return [];
  const rows = (await env.cr.query<{ id: number; res_model: string | null; create_uid: number | null }>(
    'SELECT id, res_model, create_uid FROM ir_attachment WHERE id = ANY($1::int[])', [[...attachmentIds]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const filtered: number[] = [];
  for (const aid of attachmentIds) {
    const a = byId.get(aid);
    if (!a) continue;
    if ((a.res_model === 'mail.compose.message' || a.res_model === 'mail.scheduled.message') && a.create_uid === env.uid) {
      filtered.push(aid);
    }
  }
  if (filtered.length) {
    await env.cr.query(
      `UPDATE ir_attachment SET res_model = $2, res_id = $3, write_uid = $4, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])`,
      [filtered, targetModel, targetResId, env.uid]);
  }
  if (!(await userFlags(env.cr, env.uid)).isInternal) return filtered;
  return [...attachmentIds];
}

/**
 * `mail_template.py:369-394` `_generate_template_attachments` for `report_template_ids`:
 * - Without a PDF engine (local/oracle): raises Odoo's exact `UserError` (`ir_actions_report.py:509-517`).
 * - With a PDF engine (Cloudflare Browser Run): renders each report via `renderReportPdfInRequest`,
 *   evaluates `print_report_name`, and creates the binary `ir.attachment` on `(targetModel, targetResId)`.
 */
async function renderTemplateReports(
  env: Environment,
  tpl: TemplateRow,
  resId: number,
  lang: string | null,
  targetModel: string,
  targetResId: number,
): Promise<number[]> {
  if (!resId) return [];
  const reports = (await env.cr.query<{
    id: number; report_name: string; report_type: string; attachment: string | null; attachment_use: boolean | null;
  }>(
    `SELECT r.id, r.report_name, r.report_type, r.attachment, r.attachment_use
       FROM mail_template_ir_actions_report_rel a
       JOIN ir_act_report_xml r ON r.id = a.ir_actions_report_id
      WHERE a.mail_template_id = $1 ORDER BY r.id`, [tpl.id])).rows;
  if (!reports.length) return [];
  for (const r of reports) {
    if (r.report_type !== 'qweb-html' && !r.report_type.startsWith('qweb-pdf')) {
      throw new NotPorted(`template report of type ${r.report_type}`);
    }
    if (r.attachment && r.attachment_use) {
      throw new NotPorted('template report reused from a stored attachment (_retrieve_stream_from_attachment)');
    }
  }
  if (!hasPdfEngine(env)) {
    throw new UserError(translate(env, 'Unable to find the pdf engine on this system. The PDF can not be created.'));
  }
  const renderEnv = lang ? env.withContext({ ...env.context, lang }) : env;
  const { renderReportPdfInRequest } = await import('../controllers/report');
  const company = await env.company();
  const created: number[] = [];
  for (const r of reports) {
    const pdf = await renderReportPdfInRequest(renderEnv, r.report_name, [resId]);
    const reportRec = new PyRecords(renderEnv.sudo(), 'ir.actions.report', [r.id]);
    const expr = await reportRec.field('print_report_name');
    let reportName = translate(renderEnv, 'Report');
    if (typeof expr === 'string' && expr) {
      const evaluated = await evalExprAsync(expr, new Map([['object', new PyRecords(renderEnv, tpl.model, [resId])]]));
      if (typeof evaluated === 'string' && evaluated) reportName = evaluated;
    }
    if (!reportName.endsWith('.pdf')) reportName += '.pdf';
    const aid = await createBinaryAttachment(env, {
      name: reportName,
      description: null,
      data: pdf,
      mimetype: 'application/pdf',
      resModel: targetModel,
      resId: targetResId,
      resField: null,
      company,
    });
    created.push(aid);
  }
  return created;
}

defineComputes(MODEL, {
  // mail_compose_message.py:442-451 _compute_model
  model: async (env, rec) => {
    const parentId = m2o(await rec.get('parent_id'));
    if (parentId && (await rec.get('composition_mode')) === 'comment') {
      const pm = (await env.cr.query<{ model: string | null }>('SELECT model FROM mail_message WHERE id = $1', [parentId])).rows[0]?.model;
      return pm || false;
    }
    return (await rec.prev('model')) || (env.context['active_model'] ?? false);
  },
  // :460-478 _compute_res_ids
  res_ids: async (env, rec) => {
    const current = await rec.prev('res_ids');
    if (current) return current;
    const parentId = m2o(await rec.get('parent_id'));
    if (parentId && (await rec.get('composition_mode')) === 'comment') {
      const pr = (await env.cr.query<{ res_id: number | null }>('SELECT res_id FROM mail_message WHERE id = $1', [parentId])).rows[0]?.res_id;
      return pr ? `[${pr}]` : false;
    }
    const active = env.context['active_ids'];
    if (Array.isArray(active) && active.length) {
      if (active.length <= 500) return `[${active.join(', ')}]`;
      return false;
    }
    return env.context['active_id'] ? `[${String(env.context['active_id'])}]` : false;
  },
  // :426-441
  composition_batch: async (env, rec) => Boolean(await rec.get('res_domain')) || resIds(env, await rec.get('res_ids')).length > 1,
  // :453-459
  model_is_thread: async (env, rec) => {
    const m = await rec.get('model');
    if (typeof m !== 'string' || !m) return false;
    return Boolean((await env.cr.query<{ t: boolean | null }>('SELECT is_mail_thread AS t FROM ir_model WHERE model = $1', [m])).rows[0]?.t);
  },
  // :480-507 _compute_record_environment (stored compute without depends_context('composer_force_res_ids'))
  record_company_id: async (env, rec) => {
    const modelRaw = await rec.get('model');
    const model = typeof modelRaw === 'string' && modelRaw ? modelRaw : null;
    const ids = parseResIdList(await rec.get('res_ids'));
    const isBatch = Boolean(await rec.get('res_domain')) || ids.length > 1;
    if (isBatch) return null;
    if (model && env.reg.models.has(model) && ids.length === 1) {
      return (await mailGetCompanies(env, model, [ids[0]!], await env.company())).get(ids[0]!)!;
    }
    return null;
  },
  record_alias_domain_id: async (env, rec) => {
    const modelRaw = await rec.get('model');
    const model = typeof modelRaw === 'string' && modelRaw ? modelRaw : null;
    const ids = parseResIdList(await rec.get('res_ids'));
    const isBatch = Boolean(await rec.get('res_domain')) || ids.length > 1;
    if (isBatch) return null;
    if (model && env.reg.models.has(model) && ids.length === 1) {
      const company = (await mailGetCompanies(env, model, [ids[0]!], await env.company())).get(ids[0]!)!;
      if ((await env.cr.query<{ a: number | null }>('SELECT alias_domain_id AS a FROM res_company WHERE id = $1', [company])).rows[0]?.a) throw new NotPorted('record alias domains (_mail_get_alias_domains)');
      if ((await env.cr.query('SELECT 1 FROM mail_alias_domain LIMIT 1')).rows.length) throw new NotPorted('alias domains (_mail_get_alias_domains default)');
    }
    return null;
  },
  // :508-516 (a given subtype stays in comment mode; mass_mail resets to False)
  subtype_id: async (env, rec) => (await rec.get('composition_mode')) === 'comment'
    ? ((await rec.prev('subtype_id')) || await xmlid(env, 'mail.mt_comment'))
    : null,
  // :518-525
  subtype_is_log: async (env, rec) => m2o(await rec.get('subtype_id')) === await xmlid(env, 'mail.mt_note'),
  // :236-265 _compute_subject
  subject: async (env, rec) => {
    const st = await composerState(env, rec);
    let subject: unknown = false;
    if (st.templateId !== null) {
      const tpl = await templateRow(env, st.templateId);
      const v = await fromTemplate(env, st, tpl, 'subject');
      if (v) return v;
      subject = await rec.prev('subject');
      if (subject) return subject;
    }
    if (st.parentId !== null) {
      subject = (await env.cr.query<{ s: string | null }>('SELECT subject AS s FROM mail_message WHERE id = $1', [st.parentId])).rows[0]?.s ?? false;
    }
    if (!subject && st.model && st.isMonoComment) {
      if (st.ids.length) {
        subject = await suggestedSubjectFor(env, st.model, st.ids[0]!);
      } else {
        subject = '';
      }
    }
    return subject || false;
  },
  // :266-277 _compute_subject_placeholder
  subject_placeholder: async (env, rec) => {
    const st = await composerState(env, rec);
    let subject: string | null = null;
    if (st.isMonoComment && st.model && st.ids.length) {
      const name = (await env.sudo().model(st.model).displayName([st.ids[0]!])).get(st.ids[0]!) ?? '';
      const def = env.reg.model(st.model);
      subject = (def.isMailThread ? textwrapShorten(name, 100, '...') : name) || name || null;
    }
    return subject || translate(env, 'e.g. Welcome to MyCompany!', 'mail');
  },
  // :279-290 _compute_body
  body: async (env, rec) => {
    const st = await composerState(env, rec);
    if (st.templateId !== null) {
      const tpl = await templateRow(env, st.templateId);
      const v = await fromTemplate(env, st, tpl, 'body_html');
      return v === undefined ? rec.prev('body') : composerBody(String(v));
    }
    return false;
  },
  // :380-426 _compute_authorship
  email_from: async (env, rec) => (await authorship(env, rec)).emailFrom,
  author_id: async (env, rec) => (await authorship(env, rec)).author,
  // :291-332 _compute_attachment_ids + account/wizard/account_mail_compose_message_wizard.py:8-16
  attachment_ids: async (env, rec) => {
    const st = await composerState(env, rec);
    let result: number[] = [];
    if (st.templateId !== null) {
      const tpl = await templateRow(env, st.templateId);
      if (st.compositionMode === 'mass_mail' || st.isBatch) {
        const atts = (await env.cr.query<{ attachment_id: number }>(
          'SELECT attachment_id FROM email_template_attachment_rel WHERE email_template_id = $1 ORDER BY attachment_id', [tpl.id])).rows.map((r) => r.attachment_id);
        if (atts.length) {
          result = atts;
        } else {
          const current = await rec.prev('attachment_ids');
          result = Array.isArray(current) ? [...(current as number[])] : [];
        }
      } else {
        const resId = st.ids[0] ?? 0;
        const atts: number[] = [];
        if (resId) {
          atts.push(...(await env.cr.query<{ attachment_id: number }>(
            'SELECT attachment_id FROM email_template_attachment_rel WHERE email_template_id = $1 ORDER BY attachment_id', [tpl.id])).rows.map((r) => r.attachment_id));
          const recLang = (await renderLang(env, tpl, [resId])).get(resId) || null;
          atts.push(...await renderTemplateReports(env, tpl, resId, recLang, MODEL, 0));
        }
        if (atts.length) {
          result = atts;
        } else {
          const current = await rec.prev('attachment_ids');
          result = Array.isArray(current) ? [...(current as number[])] : [];
        }
      }
    }
    // account/wizard/account_mail_compose_message_wizard.py:12-16: include move.invoice_pdf_report_id
    if (st.model === 'account.move' && st.ids.length) {
      const pdfs = (await env.cr.query<{ id: number }>(
        `SELECT id FROM ir_attachment WHERE res_model = 'account.move' AND res_id = ANY($1::int[]) AND res_field = 'invoice_pdf_report_file' ORDER BY id`,
        [st.ids])).rows.map((r) => r.id);
      for (const pid of pdfs) if (!result.includes(pid)) result.push(pid);
    }
    return result;
  },
  // :333-355 _compute_attachment_links
  attachment_links: async (env, rec) => {
    const atts = await rec.rels('attachment_ids');
    if (!atts.length) return false;
    const maxMb = Number((await env.cr.query<{ v: string }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'mail.default.max_email_size'")).rows[0]?.v ?? 10);
    let total = 5000 + String(await rec.get('body') ?? '').length;
    for (const a of atts) total += Number(await a.get('file_size') ?? 0);
    if (total <= maxMb * 1024 * 1024) return false;
    throw new NotPorted('composer attachment links exceeding max email size');
  },
  attachment_links_info: async (env, rec) => {
    const atts = await rec.rels('attachment_ids');
    if (!atts.length) return false;
    const maxMb = Number((await env.cr.query<{ v: string }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'mail.default.max_email_size'")).rows[0]?.v ?? 10);
    let total = 5000 + String(await rec.get('body') ?? '').length;
    for (const a of atts) total += Number(await a.get('file_size') ?? 0);
    if (total <= maxMb * 1024 * 1024) return false;
    throw new NotPorted('composer attachment links exceeding max email size');
  },
  // :357-367
  email_add_signature: async (_env, rec) => (await rec.get('composition_mode')) === 'mass_mail' ? false : !m2o(await rec.get('template_id')),
  // :369-378
  email_layout_xmlid: async (env, rec) => {
    const tid = m2o(await rec.get('template_id'));
    if (tid === null) return false;
    return (await templateRow(env, tid)).email_layout_xmlid || rec.prev('email_layout_xmlid');
  },
  // :642-652
  auto_delete: async (env, rec) => {
    const tid = m2o(await rec.get('template_id'));
    if (tid !== null) return (await templateRow(env, tid)).auto_delete;
    return (await rec.get('composition_mode')) === 'comment';
  },
  // :654-665
  auto_delete_keep_log: async (_env, rec) => (await rec.get('composition_mode')) === 'mass_mail' && Boolean(await rec.get('auto_delete')),
  // :667-684
  force_send: async (env, rec) => {
    const st = await composerState(env, rec);
    if (!st.isBatch) return true;
    if (st.compositionMode === 'comment' || st.hasDomain) return false;
    const limit = Number((await env.cr.query<{ v: string }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'mail.mail.force.send.limit'")).rows[0]?.v ?? 100);
    return st.ids.length <= limit;
  },
  // :686-694
  mail_server_id: async (env, rec) => {
    const tid = m2o(await rec.get('template_id'));
    if (tid === null) return null;
    return (await templateRow(env, tid)).mail_server_id || rec.prev('mail_server_id');
  },
  // :730-740
  lang: async (env, rec) => {
    const st = await composerState(env, rec);
    if (st.templateId === null) return false;
    const v = await fromTemplate(env, st, await templateRow(env, st.templateId), 'lang');
    return v === undefined ? rec.prev('lang') : v;
  },
  // :717-727
  scheduled_date: async (env, rec) => {
    const st = await composerState(env, rec);
    if (st.templateId === null) return false;
    const v = await fromTemplate(env, st, await templateRow(env, st.templateId), 'scheduled_date');
    return v === undefined ? rec.prev('scheduled_date') : v;
  },
  // :527-538
  reply_to: async (env, rec) => {
    const st = await composerState(env, rec);
    if (st.templateId === null) return false;
    const v = await fromTemplate(env, st, await templateRow(env, st.templateId), 'reply_to');
    return v === undefined ? rec.prev('reply_to') : v;
  },
  // :540-557
  reply_to_force_new: async (_env, rec) => !(await rec.get('model')) || !(await rec.get('model_is_thread')) || Boolean(await rec.get('reply_to')),
  reply_to_mode: async (_env, rec) => ((await rec.get('reply_to_force_new')) ? 'new' : 'update'),
  // :565-570 assigns only when there are cc (unassigned, the column stays NULL)
  partner_cc_allowed: async (_env, rec) => (await rec.rels('partner_cc_ids')).length > 0 ? true : NOT_ASSIGNED,
  partner_ids: async (env, rec) => {
    const r = await recipients(env, rec);
    if (r.to !== undefined) return r.to;
    const current = await rec.prev('partner_ids');
    return Array.isArray(current) ? current : [];
  },
  partner_cc_ids: async (env, rec) => {
    const r = await recipients(env, rec);
    if (r.cc !== undefined) return r.cc;
    const current = await rec.prev('partner_cc_ids');
    return Array.isArray(current) ? current : [];
  },
  // :611-614
  partner_ids_all_have_email: async (_env, rec) => {
    for (const p of [...(await rec.rels('partner_ids')), ...(await rec.rels('partner_cc_ids'))]) if (!(await p.get('email'))) return false;
    return true;
  },
  // :616-640 followers of the subtype other than the user, active, sharing
  notified_bcc_contains_share: async (env, rec) => {
    const st = await composerState(env, rec);
    if (!st.model || !st.isMonoComment || !st.ids.length) return false;
    return (await env.cr.query(
      `SELECT 1 FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id JOIN res_partner p ON p.id = f.partner_id
        WHERE f.res_model = $1 AND f.res_id = $2 AND r.mail_message_subtype_id = $3 AND p.active AND p.id != $4 AND p.partner_share LIMIT 1`,
      [st.model, st.ids[0]!, m2o(await rec.get('subtype_id')), (await userInfo(env)).partnerId])).rows.length > 0;
  },
  // :696-715
  notify_author: async (_env, rec) => (await rec.get('composition_mode')) !== 'comment' ? false : NOT_ASSIGNED,
  notify_author_mention: async (_env, rec) => (await rec.get('composition_mode')) !== 'comment' ? false : NOT_ASSIGNED,
  notify_skip_followers: async (_env, rec) => {
    if ((await rec.get('composition_mode')) !== 'comment') return false;
    return (await rec.get('composition_comment_option')) === 'forward' ? true : NOT_ASSIGNED;
  },
  render_model: async (_env, rec) => rec.get('model'), // :743-746
  // :748-754 + mail_composer_mixin.py:106-112
  can_edit_body: async (env, rec) => {
    if ((await rec.get('composition_mode')) !== 'mass_mail') return true;
    if (!m2o(await rec.get('template_id'))) return true;
    return env.su || await hasGroup(env, 'base.group_system') || await hasGroup(env, 'mail.group_mail_template_editor');
  },
});

registerOverrides(MODEL, {
  // mail_compose_message.py:50-89 default_get
  defaultGet: async (env, fields, vals) => {
    if (typeof env.context['default_subtype_xmlid'] === 'string' && env.context['default_subtype_xmlid'] && fields.includes('subtype_id') && !('subtype_id' in vals)) {
      vals['subtype_id'] = await xmlid(env, env.context['default_subtype_xmlid']);
    }
    if (fields.includes('body') && env.context['default_body'] && env.context['body_contains_signature_only'] && (vals['template_id'] || env.context['default_template_id'])) {
      delete vals['body'];
    }
    if (fields.includes('create_uid') && !('create_uid' in vals)) {
      vals['create_uid'] = env.uid;
    }
  },
  create: async (env, valsList, next) => {
    for (const vals of valsList) {
      if (vals['reply_to_mode'] === 'new') {
        vals['reply_to_force_new'] = true;
      } else if (vals['reply_to_mode'] === 'update') {
        vals['reply_to_force_new'] = false;
        if (vals['reply_to'] === undefined) vals['reply_to'] = false;
      }
    }
    return next(env, valsList);
  },
  inverse: {
    reply_to_mode: async (env, ids, vals) => {
      if (vals['reply_to_mode'] === 'new') {
        await write(env, MODEL, ids, { reply_to_force_new: true });
      } else {
        await write(env, MODEL, ids, { reply_to_force_new: false, reply_to: false });
      }
    },
  },
});

/** `_mail_thread_customer` (mail_thread.py:2383-2386: the customer recipient follows): project_task.py:104. */
const THREAD_CUSTOMER = new Set(['project.task']);

/** Per-record values for posting a comment message in comment mode. */
interface CommentPost {
  readonly model: string;
  readonly resId: number;
  readonly authorId: number | false;
  readonly emailFrom: string | false;
  readonly subject: string;
  readonly body: string;
  readonly messageType: string;
  readonly subtypeId: number;
  readonly partnerIds: number[];
  readonly partnerCcIds: number[];
  readonly attachmentIds: number[];
  readonly forceEmailLang?: string;
  readonly replyTo: string | false;
  readonly replyToForceNew: boolean;
  readonly emailAddSignature: boolean;
  readonly emailLayoutXmlid: string | false;
  readonly forceSend: boolean;
  readonly autoDelete: boolean;
  readonly recordCompanyId: number | false;
  readonly mailServerId: number | false;
  readonly allowHeader: boolean;
  readonly forceHeader: boolean;
  readonly forceFooter: boolean;
  readonly modelDescription: string | undefined;
  readonly notifyAuthorMention: boolean;
  readonly notifySkipFollowers: boolean;
  readonly skipAuthorAutofollow: boolean;
}

/** Check document / model aliases for reply-to; returns default reply-to when no alias domains exist. */
async function computeReplyTo(env: Environment, model: string, resId: number, explicitReplyTo: string | false, emailFrom: string | false): Promise<string | false> {
  if (explicitReplyTo) return explicitReplyTo;
  const aliases = (await env.cr.query<{ n: string }>(`SELECT count(*)::text n FROM mail_alias a JOIN ir_model m ON m.id = a.alias_parent_model_id
      WHERE a.alias_domain_id IS NOT NULL AND m.model = $1 AND a.alias_parent_thread_id = $2 AND a.alias_name IS NOT NULL`, [model, resId])).rows[0];
  if (Number(aliases?.n ?? 0) > 0) throw new NotPorted('reply-to through a document alias');
  // project.task & crm.lead delegate _notify_get_reply_to to project/team alias: without any mail_alias_domain, it falls back to replyToDefault
  if (['project.task', 'crm.lead', 'hr.applicant'].includes(model)) {
    if ((await env.cr.query('SELECT 1 FROM mail_alias_domain LIMIT 1')).rows.length) {
      throw new NotPorted(`reply-to of ${model} (_notify_get_reply_to override with alias domains)`);
    }
  }
  return replyToDefault(env, emailFrom);
}

/** Post one prepared comment message on `(p.model, p.resId)` and trigger notifications. Returns the new message id. */
async function postOneComment(env: Environment, p: CommentPost): Promise<number> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('composer send outside a request');
  const def = env.reg.model(p.model);
  if (!def.isMailThread) throw new NotPorted(`composer send on ${p.model} (message_notify)`);
  if (!p.allowHeader) throw new NotPorted('composer send without the notification header (email_notification_allow_header)');
  // sale/models/sale_order.py:2200-2206 & purchase/models/purchase_order.py:547-551 `message_post` overrides
  let notifyAuthorMention = p.notifyAuthorMention;
  if (p.model === 'sale.order' && env.context['mark_so_as_sent']) {
    const st = (await env.cr.query<{ state: string | null }>('SELECT state FROM sale_order WHERE id = $1', [p.resId])).rows[0]?.state;
    if (st === 'draft') {
      await write(env.withContext({ ...env.context, tracking_disable: true }), 'sale.order', [p.resId], { state: 'sent' });
    }
    notifyAuthorMention = true;
  } else if (p.model === 'purchase.order' && env.context['mark_rfq_as_sent']) {
    const st = (await env.cr.query<{ state: string | null }>('SELECT state FROM purchase_order WHERE id = $1', [p.resId])).rows[0]?.state;
    if (st === 'draft') {
      await write(env, 'purchase.order', [p.resId], { state: 'sent' });
    }
    notifyAuthorMention = true;
  }
  // mail_thread.py:2380-2386 recipients' subscription
  if (env.context['mail_post_autofollow'] && p.partnerIds.length) {
    await messageSubscribe(env, p.model, [p.resId], p.partnerIds, null);
  } else if (THREAD_CUSTOMER.has(p.model) && p.partnerIds.length && env.context['mail_post_autofollow'] !== false) {
    const customers = (await mailGetPartners(env, p.model, [p.resId])).get(p.resId) ?? [];
    const matched = customers.filter((pid) => p.partnerIds.includes(pid));
    if (matched.length) await messageSubscribe(env, p.model, [p.resId], matched, null);
  }
  const authorId = p.authorId;
  const emailFrom = p.emailFrom;
  // `escape(body)` keeps the composer's Markup; the message field sanitizes it again (mail_message.py:175)
  const msgDef = env.reg.model('mail.message');
  const body = p.body ? await sanitizeHtml(env, msgDef, msgDef.fields.get('body')!, p.body) : '';
  const replyTo = await computeReplyTo(env, p.model, p.resId, p.replyTo, emailFrom);
  const parentId = p.model === 'res.partner' || p.model === 'discuss.channel' ? false : await flatParent(env, p.model, p.resId);
  // mail_thread.py:2425-2427 `_process_attachments_for_post`
  const finalAttachmentIds = await processAttachmentsForPost(env, p.attachmentIds, p.model, p.resId);
  const [mid] = await insertMessages(env, [{
    model: p.model, res_id: p.resId, body, author_id: authorId, email_from: emailFrom, message_type: p.messageType, subtype_id: p.subtypeId,
    subject: p.subject || false, reply_to: replyTo, message_id: trackingMessageId(`${p.resId}-${p.model}`), email_add_signature: p.emailAddSignature,
    record_alias_domain_id: false, record_company_id: p.recordCompanyId, email_layout_xmlid: p.emailLayoutXmlid, partner_ids: p.partnerIds,
    partner_cc_ids: p.partnerCcIds, attachment_ids: finalAttachmentIds, mail_server_id: p.mailServerId, reply_to_force_new: p.replyToForceNew,
    ...(parentId ? { parent_id: parentId } : {}),
  }]);
  // :2436-2445 + :3159-3171 `_message_compute_real_author`: the real author follows the thread of a comment
  const comment = await xmlid(env, 'mail.mt_comment');
  if (!p.skipAuthorAutofollow && !env.context['mail_post_autofollow_author_skip']
    && !['notification', 'user_notification', 'auto_comment', 'out_of_office'].includes(p.messageType) && p.subtypeId === comment) {
    const user = await userInfo(env);
    let realAuthor: number | null = null;
    if (user.active) {
      realAuthor = user.partnerId;
    } else if (typeof authorId === 'number' && authorId) {
      const a = (await env.cr.query<{ active: boolean | null; root: boolean }>(
        `SELECT p.active, EXISTS (SELECT 1 FROM ir_model_data d WHERE d.module = 'base' AND d.name = 'partner_root' AND d.model = 'res.partner' AND d.res_id = p.id) AS root
           FROM res_partner p WHERE p.id = $1`, [authorId])).rows[0];
      if (a?.active && !a.root) realAuthor = authorId;
    }
    if (realAuthor !== null) {
      const share = (await env.cr.query<{ s: boolean | null }>('SELECT partner_share AS s FROM res_partner WHERE id = $1', [realAuthor])).rows[0]?.s;
      if (!share) await messageSubscribe(env, p.model, [p.resId], [realAuthor], null);
    }
  }
  // :2447 `_message_post_after_hook` (account.move / main attachment hook runs before _notify_thread;
  // crm.lead tracking runs at precommit after _notify_thread, so leadPartnerFromRecipients runs below)
  if (finalAttachmentIds.length) {
    await messagePostAfterHook(ctx.env, env, p.model, p.resId, mid!, finalAttachmentIds, {});
  }
  const nr = await notifyThread(ctx, env, p.model, p.resId, mid!, {
    light: p.emailLayoutXmlid === 'mail.mail_notification_light',
    autoDelete: p.autoDelete,
    forceHeader: p.forceHeader,
    forceFooter: p.forceFooter,
    allowFooter: Boolean(env.context['email_notification_allow_footer']),
    ...(p.modelDescription ? { modelDescription: p.modelDescription } : {}),
    notifyAuthorMention,
    skipFollowers: p.notifySkipFollowers,
    ...(p.forceEmailLang ? { forceEmailLang: p.forceEmailLang } : {}),
  });
  if (p.forceSend) await nr.send();
  // crm_lead.py:2128-2145 `_message_post_after_hook` (tracking logs at precommit, after _notify_thread)
  if (p.model === 'crm.lead' && p.partnerIds.length) {
    await leadPartnerFromRecipients(env, p.resId, p.partnerIds);
  }
  return mid!;
}

/**
 * :901-929 `_action_send_mail_comment` for one or several records (mono or batch comment mode).
 * Returns the posted message ids in `res_ids` order.
 */
export async function sendComposerComments(env: Environment, composerId: number): Promise<number[]> {
  const w = (await env.cr.query<Record<string, unknown>>('SELECT * FROM mail_compose_message WHERE id = $1', [composerId])).rows[0];
  if (!w) throw new NotPorted('mail.compose.message that does not exist');
  if (w['composition_mode'] !== 'comment' || w['parent_id'] !== null || w['mail_activity_type_id'] !== null) {
    throw new NotPorted('composer send with parent_id or mail_activity_type_id in comment mode');
  }
  const model = String(w['model'] ?? '');
  if (!model) throw new NotPorted('action_send_mail without a model');
  const hasDomain = Boolean(w['res_domain']);
  const ids = hasDomain ? await evaluateResDomain(env, model, w['res_domain']) : resIds(env, w['res_ids']);
  if (!ids.length) throw new UserError(`Mail composer in comment mode should run on at least one record. No records found (model ${model}).`);
  const isBatch = hasDomain || ids.length > 1;
  if (w['scheduled_date']) throw new NotPorted('composer send with a scheduled date (mail.scheduled.message)');
  if (w['notify_author']) throw new NotPorted('composer send with notify_author');

  // :905-906 full composer marker
  let wizardBody = String(w['body'] ?? '');
  if (env.context['is_full_composer'] && wizardBody && !isHtmlEmpty(wizardBody) && !wizardBody.includes('data-o-mail-full-composer')) {
    wizardBody = composerBody(`<span data-o-mail-full-composer="1"></span>${wizardBody}`);
    await env.cr.query(`UPDATE mail_compose_message SET body = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [composerId, wizardBody, env.uid]);
  }

  const templateId = m2o(w['template_id']);
  let forceFooter = false;
  let forceHeader = false;
  let tpl: TemplateRow | null = null;
  if (templateId !== null) {
    tpl = await templateRow(env, templateId);
    const tflags = (await env.cr.query<{ f: boolean | null; h: boolean | null }>(
      'SELECT email_layout_force_footer AS f, email_layout_force_header AS h FROM mail_template WHERE id = $1', [templateId])).rows[0];
    forceFooter = Boolean(tflags?.f);
    forceHeader = Boolean(tflags?.h);
  }

  const subtypeId = m2o(w['subtype_id']) ?? await xmlid(env, 'mail.mt_comment');
  const modelDesc = typeof env.context['model_description'] === 'string' && env.context['model_description'] ? env.context['model_description'] : undefined;
  const replyToRaw = typeof w['reply_to'] === 'string' && w['reply_to'] ? w['reply_to'] : false;
  const replyToForceNew = Boolean(w['reply_to_force_new']) && Boolean(replyToRaw);
  const staticCommon = {
    model,
    authorId: m2o(w['author_id']) ?? false as number | false,
    messageType: String(w['message_type']),
    subtypeId,
    replyToForceNew,
    emailAddSignature: Boolean(w['email_add_signature']),
    emailLayoutXmlid: typeof w['email_layout_xmlid'] === 'string' && w['email_layout_xmlid'] ? w['email_layout_xmlid'] : false as string | false,
    forceSend: Boolean(w['force_send']),
    autoDelete: Boolean(w['auto_delete']),
    mailServerId: m2o(w['mail_server_id']) ?? false as number | false,
    allowHeader: w['email_notification_allow_header'] !== false,
    forceHeader,
    forceFooter,
    modelDescription: modelDesc,
    notifyAuthorMention: Boolean(w['notify_author_mention']),
    notifySkipFollowers: Boolean(w['notify_skip_followers']),
    skipAuthorAutofollow: isBatch,
  };

  // Wizard attachments in ir.attachment default order (id DESC)
  const wizardAttIds = (await env.cr.query<{ attachment_id: number }>(
    'SELECT attachment_id FROM mail_compose_message_ir_attachments_rel WHERE wizard_id = $1 ORDER BY attachment_id DESC',
    [composerId])).rows.map((r) => r.attachment_id);

  if (!isBatch) {
    // :1444-1456 `_prepare_mail_values_rendered`: copy attachments owned by template_id so their ownership stays on the template
    let sendAttIds = [...wizardAttIds];
    if (tpl !== null && wizardAttIds.length) {
      const tplAttSet = new Set((await env.cr.query<{ attachment_id: number }>(
        'SELECT attachment_id FROM email_template_attachment_rel WHERE email_template_id = $1', [tpl.id])).rows.map((r) => r.attachment_id));
      const newIds: number[] = [];
      let copiedAny = false;
      for (const aid of wizardAttIds) {
        if (tplAttSet.has(aid)) {
          newIds.push(await copyAttachment(env, aid, MODEL, composerId));
          copiedAny = true;
        } else {
          newIds.push(aid);
        }
      }
      newIds.reverse();
      if (copiedAny) {
        await env.cr.query('DELETE FROM mail_compose_message_ir_attachments_rel WHERE wizard_id = $1', [composerId]);
        for (const aid of newIds) {
          await env.cr.query('INSERT INTO mail_compose_message_ir_attachments_rel (wizard_id, attachment_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [composerId, aid]);
        }
        await env.cr.query(`UPDATE mail_compose_message SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [composerId, env.uid]);
      }
      sendAttIds = newIds;
    }
    const partners = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_compose_message_res_partner_rel WHERE wizard_id = $1 ORDER BY partner_id', [composerId])).rows.map((r) => r.partner_id);
    const partnersCc = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_compose_message_res_partner_cc_rel WHERE wizard_id = $1 ORDER BY partner_id', [composerId])).rows.map((r) => r.partner_id);
    const forceEmailLang = typeof w['lang'] === 'string' && w['lang'] ? w['lang'] : undefined;
    const mid = await postOneComment(env, {
      ...staticCommon,
      resId: ids[0]!,
      emailFrom: typeof w['email_from'] === 'string' ? w['email_from'] : false,
      subject: String(w['subject'] ?? ''),
      body: wizardBody,
      partnerIds: partners,
      partnerCcIds: partnersCc,
      attachmentIds: sendAttIds,
      ...(forceEmailLang ? { forceEmailLang } : {}),
      replyTo: replyToRaw,
      recordCompanyId: m2o(w['record_company_id']) ?? false,
    });
    return [mid];
  }

  // Batch comment mode (:1231-1425 `_prepare_mail_values_dynamic` + :909-929)
  const companies = await mailGetCompanies(env, model, ids, await env.company());
  if ((await env.cr.query('SELECT 1 FROM mail_alias_domain LIMIT 1')).rows.length) {
    throw new NotPorted('batch comment composer with alias domains');
  }
  const rawSubject = String(w['subject'] ?? '');
  const rawEmailFrom = typeof w['email_from'] === 'string' ? w['email_from'] : '';
  const rawLang = typeof w['lang'] === 'string' && w['lang'] ? w['lang'] : null;
  // :1255 `self._render_lang(res_ids)` of the composer: its lang (the template's), else the customers' (:770-775)
  const tplLangs = rawLang ? new Map<number, string | false>() : tpl !== null ? await renderLang(env, tpl, ids) : await customerLangs(env, model, ids);
  const postedIds: number[] = [];
  for (const resId of ids) {
    const recLang = rawLang
      ? (await renderInlineForRecord(env, rawLang, model, resId, null) || null)
      : (tplLangs.get(resId) || null);
    const subject = rawSubject ? await renderInlineForRecord(env, rawSubject, model, resId, recLang) : '';
    const body = wizardBody ? await renderQwebBodyForRecord(env, wizardBody, model, resId, recLang) : '';
    const emailFrom: string | false = rawEmailFrom ? await renderInlineForRecord(env, rawEmailFrom, model, resId, null) : false;
    const replyTo: string | false = replyToForceNew && replyToRaw
      ? await renderInlineForRecord(env, replyToRaw, model, resId, null)
      : false;
    let partnerIds: number[] = [];
    let partnerCcIds: number[] = [];
    if (tpl !== null) {
      const forcePartners = env.context['mail_composer_force_partners'] !== false;
      const r = await templateRecipientsForRecord(env, tpl, resId, false, forcePartners);
      partnerIds = r.to;
      partnerCcIds = r.cc;
    }
    // :1340-1359 per-record attachment copies + report attachments
    const copiedAttIds: number[] = [];
    for (const aid of wizardAttIds) copiedAttIds.push(await copyAttachment(env, aid, MODEL, composerId));
    copiedAttIds.reverse();
    if (tpl !== null) {
      copiedAttIds.push(...await renderTemplateReports(env, tpl, resId, recLang, model, resId));
    }
    const mid = await postOneComment(env, {
      ...staticCommon,
      resId,
      emailFrom,
      subject,
      body,
      partnerIds,
      partnerCcIds,
      attachmentIds: copiedAttIds,
      ...(recLang ? { forceEmailLang: recLang } : {}),
      replyTo,
      recordCompanyId: companies.get(resId) ?? false,
    });
    postedIds.push(mid);
  }
  return postedIds;
}

/** Single-record comment send (kept as export for src/mail/post_source.ts). */
export async function sendComposerComment(env: Environment, composerId: number): Promise<number> {
  const mids = await sendComposerComments(env, composerId);
  return mids[0]!;
}

/** Python `repr()` of a dict of str values (headers). */
function reprHeaders(d: ReadonlyArray<[string, string]>): string {
  const r = (s: string): string => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  return `{${d.map(([k, v]) => `${r(k)}: ${r(v)}`).join(', ')}}`;
}

/**
 * :931-993 `_action_send_mail_mass_mail` + :1231-1425 + :1478-1538 `_process_mail_values_state`:
 * Creates `mail.mail` (and `mail.notification` when kept) for each record in `res_ids` / `res_domain`,
 * and triggers SMTP send when `force_send` is true.
 */
async function sendComposerMassMail(env: Environment, composerId: number): Promise<number[]> {
  const w = (await env.cr.query<Record<string, unknown>>('SELECT * FROM mail_compose_message WHERE id = $1', [composerId])).rows[0];
  if (!w) throw new NotPorted('mail.compose.message that does not exist');
  const model = String(w['model'] ?? '');
  if (!model) throw new NotPorted('mass_mail composer without a model');
  const hasDomain = Boolean(w['res_domain']);
  const ids = hasDomain ? await evaluateResDomain(env, model, w['res_domain']) : resIds(env, w['res_ids']);
  if (!ids.length) return [];
  if (w['email_layout_xmlid']) throw new NotPorted('mass_mail composer with email_layout_xmlid');
  if ((await env.cr.query('SELECT 1 FROM mail_alias_domain LIMIT 1')).rows.length) {
    throw new NotPorted('mass_mail composer with alias domains');
  }

  const templateId = m2o(w['template_id']);
  const tpl = templateId !== null ? await templateRow(env, templateId) : null;

  const wizardPartnerIds = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_compose_message_res_partner_rel WHERE wizard_id = $1 ORDER BY partner_id', [composerId])).rows.map((r) => r.partner_id);
  const wizardPartnerCcIds = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM mail_compose_message_res_partner_cc_rel WHERE wizard_id = $1 ORDER BY partner_id', [composerId])).rows.map((r) => r.partner_id);
  const wizardAttIds = (await env.cr.query<{ attachment_id: number }>(
    'SELECT attachment_id FROM mail_compose_message_ir_attachments_rel WHERE wizard_id = $1 ORDER BY attachment_id DESC',
    [composerId])).rows.map((r) => r.attachment_id);
  const companies = await mailGetCompanies(env, model, ids, await env.company());
  const defaultRecs = !tpl && !wizardPartnerIds.length ? await defaultRecipients(env, model, ids) : new Map();

  const autoDelete = Boolean(w['auto_delete']);
  const autoDeleteKeepLog = Boolean(w['auto_delete_keep_log']);
  const isNotification = !autoDelete || autoDeleteKeepLog;
  const invalidEmailState = autoDelete && !autoDeleteKeepLog ? 'cancel' : 'exception';
  const replyToRaw = typeof w['reply_to'] === 'string' && w['reply_to'] ? w['reply_to'] : false;
  const replyToForceNew = Boolean(w['reply_to_force_new']) && Boolean(replyToRaw);
  const rawSubject = String(w['subject'] ?? '');
  const rawBody = String(w['body'] ?? '');
  const rawEmailFrom = typeof w['email_from'] === 'string' ? w['email_from'] : '';
  const rawLang = typeof w['lang'] === 'string' && w['lang'] ? w['lang'] : null;
  const def = env.reg.model(model);
  const keepAttachmentsOnRecord = def.isMailThread && !(autoDelete && !autoDeleteKeepLog);

  // Blacklist emails (active=true) if use_exclusion_list is true
  const useExclusion = w['use_exclusion_list'] !== false;
  const blacklist = useExclusion
    ? new Set((await env.cr.query<{ email: string }>('SELECT email FROM mail_blacklist WHERE active IS TRUE')).rows.map((r) => r.email))
    : new Set<string>();

  // Prepare per-record values
  interface MailDraft {
    resId: number;
    vals: Record<string, unknown>;
    recipientIds: number[];
    recipientCcIds: number[];
    emailTo: string;
    emailCc: string;
    attachmentCount: number;
  }
  const drafts: MailDraft[] = [];
  const allRecipientPids = new Set<number>();

  // Compute template langs if composer has no explicit lang
  const tplLangs = rawLang ? new Map<number, string | false>() : tpl ? await renderLang(env, tpl, ids) : await customerLangs(env, model, ids);

  for (const resId of ids) {
    const recLang = rawLang
      ? (await renderInlineForRecord(env, rawLang, model, resId, null) || null)
      : (tplLangs.get(resId) || null);
    const subject = rawSubject ? await renderInlineForRecord(env, rawSubject, model, resId, recLang) : '';
    const body = rawBody ? await renderQwebBodyForRecord(env, rawBody, model, resId, recLang) : '';
    const emailFrom = rawEmailFrom ? await renderInlineForRecord(env, rawEmailFrom, model, resId, null) : '';
    const replyTo = (replyToForceNew && replyToRaw
      ? await renderInlineForRecord(env, replyToRaw, model, resId, null)
      : await computeReplyTo(env, model, resId, false, emailFrom || false)) || emailFrom || false;

    let partnerIds: number[] = [];
    let partnerCcIds: number[] = [];
    let emailTo: string | undefined;
    let emailCc: string | undefined;
    let scheduledDate: string | false = false;
    if (tpl !== null) {
      const forcePartners = env.context['mail_composer_force_partners'] !== false;
      const r = await templateRecipientsForRecord(env, tpl, resId, false, forcePartners);
      partnerIds = r.to;
      partnerCcIds = r.cc;
      if (r.emailTo) emailTo = r.emailTo;
      if (r.emailCc) emailCc = r.emailCc;
      if (tpl.scheduled_date) {
        const sVal = (await generateTemplate(env, tpl, [resId], ['scheduled_date'])).get(resId)!['scheduled_date'];
        scheduledDate = typeof sVal === 'string' && sVal ? sVal : false;
      }
    } else if (!wizardPartnerIds.length) {
      const dr = defaultRecs.get(resId);
      if (dr) {
        partnerIds = [...dr.partner_ids];
        emailTo = dr.email_to;
        emailCc = dr.email_cc;
      }
    }
    const combinedTo = [...new Set([...partnerIds, ...wizardPartnerIds])].sort((a, b) => a - b);
    const combinedCc = [...new Set([...partnerCcIds, ...wizardPartnerCcIds])].sort((a, b) => a - b);
    for (const pid of combinedTo) allRecipientPids.add(pid);
    for (const pid of combinedCc) allRecipientPids.add(pid);

    // :1340-1355 copy wizard attachments per record + render template reports + _process_attachments_for_post
    const attTargetModel = keepAttachmentsOnRecord ? model : 'mail.message';
    const attTargetResId = keepAttachmentsOnRecord ? resId : 0;
    const copiedAttIds: number[] = [];
    for (const aid of wizardAttIds) copiedAttIds.push(await copyAttachment(env, aid, MODEL, composerId));
    copiedAttIds.reverse();
    const processedAttIds = await processAttachmentsForPost(env, copiedAttIds, attTargetModel, attTargetResId);
    if (tpl !== null) {
      processedAttIds.push(...await renderTemplateReports(env, tpl, resId, recLang, attTargetModel, attTargetResId));
    }

    const headers = reprHeaders([['X-Odoo-Objects', `${model}-${resId}`]]);
    const vals: Record<string, unknown> = {
      author_id: m2o(w['author_id']) ?? false,
      mail_activity_type_id: m2o(w['mail_activity_type_id']) ?? false,
      mail_server_id: m2o(w['mail_server_id']) ?? false,
      message_type: 'email_outgoing',
      parent_id: m2o(w['parent_id']) ?? false,
      reply_to_force_new: replyToForceNew,
      subtype_id: false,
      auto_delete: autoDelete,
      is_notification: isNotification,
      model,
      res_id: resId,
      body,
      body_html: body,
      email_from: emailFrom,
      scheduled_date: scheduledDate,
      subject,
      record_alias_domain_id: false,
      record_company_id: companies.get(resId) ?? false,
      headers,
      reply_to: replyTo,
      recipient_ids: combinedTo.map((pid) => [4, pid, 0]),
      recipient_cc_ids: combinedCc.map((pid) => [4, pid, 0]),
      ...(processedAttIds.length ? { attachment_ids: processedAttIds.map((aid) => [4, aid, 0]) } : {}),
      ...(emailTo !== undefined ? { email_to: emailTo } : {}),
      ...(emailCc !== undefined ? { email_cc: emailCc } : {}),
    };
    drafts.push({ resId, vals, recipientIds: combinedTo, recipientCcIds: combinedCc, emailTo: emailTo ?? '', emailCc: emailCc ?? '', attachmentCount: processedAttIds.length });
  }

  // _process_mail_values_state (:1478-1538)
  const partnerEmails = new Map<number, string | null>();
  if (allRecipientPids.size) {
    for (const r of (await env.cr.query<{ id: number; email: string | null }>('SELECT id, email FROM res_partner WHERE id = ANY($1::int[])', [[...allRecipientPids]])).rows) {
      partnerEmails.set(r.id, r.email);
    }
  }
  const sentMapping = new Map<string, Array<{ subject: unknown; body: unknown }>>();
  for (const d of drafts) {
    const rawTo: string[] = [];
    for (const [, addr] of emailSplitTuples(d.emailTo)) if (addr && !rawTo.includes(addr)) rawTo.push(addr);
    if (!rawTo.length && d.emailTo) rawTo.push(d.emailTo);
    for (const pid of d.recipientIds) {
      const e = partnerEmails.get(pid);
      if (e && !rawTo.includes(e)) rawTo.push(e);
    }
    const normTo = rawTo.map((e) => emailNormalize(e)).filter((e): e is string => e !== null);
    const isBlacklisted = blacklist.size > 0 && normTo.some((e) => blacklist.has(e));
    if (isBlacklisted) {
      d.vals['state'] = 'cancel';
      d.vals['failure_type'] = 'mail_bl';
      d.vals['is_notification'] = false;
    } else if (!rawTo.some(Boolean)) {
      d.vals['state'] = invalidEmailState;
      d.vals['failure_type'] = 'mail_email_missing';
    } else if (!normTo.length) {
      d.vals['state'] = invalidEmailState;
      d.vals['failure_type'] = 'mail_email_invalid';
    } else if (wizardAttIds.length === d.attachmentCount && normTo.every((e) => sentMapping.has(e)) && normTo.some((e) => sentMapping.get(e)!.some((prev) => prev.subject === d.vals['subject'] && prev.body === d.vals['body']))) {
      d.vals['state'] = 'cancel';
      d.vals['failure_type'] = 'mail_dup';
    } else {
      for (const e of normTo) {
        const list = sentMapping.get(e) ?? [];
        list.push({ subject: d.vals['subject'], body: d.vals['body'] });
        sentMapping.set(e, list);
      }
    }
    const msgId = trackingMessageId(replyToForceNew ? 'reply_to' : (def.isMailThread ? `${d.resId}-${model}` : 'private'));
    d.vals['message_id'] = msgId;
    d.vals['references'] = msgId;
  }

  // Create mail.mail records as sudo
  const mailIds = await create(env.sudo(), 'mail.mail', drafts.map((d) => d.vals));

  // _generate_mail_notification_values (:974-992)
  if (!autoDelete || autoDeleteKeepLog) {
    const mailRows = (await env.cr.query<{ id: number; mail_message_id: number; state: string | null; failure_type: string | null; author_id: number | null }>(
      `SELECT mm.id, mm.mail_message_id, mm.state, mm.failure_type, m.author_id
         FROM mail_mail mm JOIN mail_message m ON m.id = mm.mail_message_id
        WHERE mm.id = ANY($1::int[])`, [mailIds])).rows;
    const byId = new Map(mailRows.map((r) => [r.id, r]));
    const statusOf = (state: string | null): string => ({ outgoing: 'ready', sent: 'sent', received: 'sent', exception: 'exception', cancel: 'canceled' }[state ?? 'outgoing'] ?? 'ready');
    for (let i = 0; i < mailIds.length; i++) {
      const mailId = mailIds[i]!;
      const d = drafts[i]!;
      const mr = byId.get(mailId)!;
      const notifStatus = statusOf(mr.state);
      const allPids = [...new Set([...d.recipientIds, ...d.recipientCcIds])];
      const extraEmails = [...new Set(emailSplitTuples(`${d.emailTo}, ${d.emailCc}`).map(([, a]) => emailNormalize(a)).filter((e): e is string => e !== null))];
      if (!allPids.length && !extraEmails.length) {
        await env.cr.query(
          `INSERT INTO mail_notification (author_id, is_read, read_date, mail_mail_id, mail_message_id, notification_type, notification_status, failure_type)
           VALUES ($1, TRUE, date_trunc('second', now() AT TIME ZONE 'UTC'), $2, $3, 'email', $4, $5)`,
          [mr.author_id, mailId, mr.mail_message_id, notifStatus, mr.failure_type]);
      } else {
        for (const pid of allPids) {
          await env.cr.query(
            `INSERT INTO mail_notification (author_id, is_read, read_date, mail_mail_id, mail_message_id, notification_type, notification_status, failure_type, res_partner_id, mail_email_address)
             VALUES ($1, TRUE, date_trunc('second', now() AT TIME ZONE 'UTC'), $2, $3, 'email', $4, $5, $6, $7)`,
            [mr.author_id, mailId, mr.mail_message_id, notifStatus, mr.failure_type, pid, partnerEmails.get(pid) ?? null]);
        }
        for (const email of extraEmails) {
          await env.cr.query(
            `INSERT INTO mail_notification (author_id, is_read, read_date, mail_mail_id, mail_message_id, notification_type, notification_status, failure_type, mail_email_address)
             VALUES ($1, TRUE, date_trunc('second', now() AT TIME ZONE 'UTC'), $2, $3, 'email', $4, $5, $6)`,
            [mr.author_id, mailId, mr.mail_message_id, notifStatus, mr.failure_type, email]);
        }
      }
    }
  }

  // :947-949 `_message_mail_after_hook`: purchase.order transitions draft RFQs to 'sent'
  if (model === 'purchase.order') {
    const draftPos = (await env.cr.query<{ id: number }>(
      `SELECT id FROM purchase_order WHERE id = ANY($1::int[]) AND state = 'draft'`, [ids])).rows.map((r) => r.id);
    if (draftPos.length) await write(env, 'purchase.order', draftPos, { state: 'sent' });
  }

  // :951-962 force_send (only outgoing mails not scheduled in the future)
  if (w['force_send']) {
    const toSend = (await env.cr.query<{ id: number; mail_message_id: number; is_notification: boolean | null }>(
      `SELECT id, mail_message_id, is_notification FROM mail_mail
        WHERE id = ANY($1::int[]) AND state = 'outgoing' AND (scheduled_date IS NULL OR scheduled_date <= now() AT TIME ZONE 'UTC')
        ORDER BY id`, [mailIds])).rows;
    if (toSend.length) {
      const reason = await smtpConnectFailure();
      const sendIds = toSend.map((r) => r.id);
      await env.cr.query(`UPDATE mail_mail SET state = 'exception', failure_reason = $2, write_uid = 1, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])`, [sendIds, reason]);
      const notifMailIds = toSend.filter((r) => r.is_notification).map((r) => r.id);
      if (notifMailIds.length) {
        const failedNotifs = (await env.cr.query<{ id: number; mail_message_id: number }>(
          `UPDATE mail_notification SET notification_status = 'exception', failure_type = 'mail_smtp', failure_reason = NULL
            WHERE mail_mail_id = ANY($1::int[]) AND notification_type = 'email' AND notification_status NOT IN ('sent', 'canceled')
            RETURNING id, mail_message_id`, [notifMailIds])).rows;
        if (failedNotifs.length) {
          const written: Record<string, Record<string, string[]>> = { 'mail.mail': {}, 'mail.notification': {} };
          for (const mid of sendIds) written['mail.mail']![String(mid)] = ['state', 'failure_reason', 'write_uid', 'write_date'];
          for (const n of failedNotifs) written['mail.notification']![String(n.id)] = ['notification_status', 'failure_type'];
          const msgIds = [...new Set(failedNotifs.map((n) => n.mail_message_id))];
          for (const msgId of msgIds) await notifyFailure(env, msgId, written);
        }
      }
    }
  }

  return mailIds;
}

/** mail_compose_message.py:847-860 `action_send_mail`, :862-893 `_action_send_mail`. */
registerMethod(MODEL, 'action_send_mail', async (env0, ids, _args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  if (ids?.length !== 1) throw new NotPorted('action_send_mail on several composers (Expected singleton)');
  await env.model(MODEL).checkAccess([ids[0]!], 'write');
  const w = (await env.cr.query<{ model: string | null; res_ids: string | null; res_domain: string | null; composition_mode: string | null }>(
    'SELECT model, res_ids, res_domain, composition_mode FROM mail_compose_message WHERE id = $1', [ids[0]])).rows[0];
  if (!w || !w.model) throw new NotPorted('action_send_mail without a model');
  const mode = w.composition_mode ?? 'comment';
  const targetIds = w.res_domain ? await evaluateResDomain(env, w.model, w.res_domain) : resIds(env, w.res_ids);
  if (mode === 'comment') {
    if (!targetIds.length) throw new UserError(`Mail composer in comment mode should run on at least one record. No records found (model ${w.model}).`);
    const postOp: 'read' | 'write' = w.model === 'res.partner' ? 'read' : isGenericThread(w.model) ? postAccessOf(w.model) : 'write';
    for (const rid of targetIds) {
      if (!(await permissionOn(env, w.model, rid, postOp))) {
        await env.model(w.model).checkAccess([rid], postOp);
        throw new AccessError(`Not allowed to ${postOp} ${w.model}(${rid})`);
      }
    }
    await sendComposerComments(env, ids[0]!);
  } else if (mode === 'mass_mail') {
    for (const rid of targetIds) {
      if (!(await permissionOn(env, w.model, rid, 'read'))) {
        await env.model(w.model).checkAccess([rid], 'read');
        throw new AccessError(`Not allowed to read ${w.model}(${rid})`);
      }
    }
    await sendComposerMassMail(env, ids[0]!);
  } else {
    throw new NotPorted(`action_send_mail in composition_mode ${mode}`);
  }
  const evalIds = resIds(env, w.res_ids);
  const name = w.model && evalIds.length === 1 && mode === 'comment'
    ? ((await env.model(w.model).displayName([evalIds[0]!])).get(evalIds[0]!) ?? false)
    : false;
  return { type: 'ir.actions.client', tag: 'action_send_mail_callback', params: { record_name: name } };
}, { apiModel: false });
