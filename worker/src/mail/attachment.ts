/**
 * `/mail/attachment/upload` (odoo/addons/mail/controllers/attachment.py:63) for internal users on partner threads:
 * `ir.attachment.create` (odoo/odoo/addons/base/models/ir_attachment.py:921: `_check_contents` :532,
 * `_compute_mimetype` :469, `_postprocess_contents` :492, `_get_datas_related_values` :424, `_index` :561,
 * `_file_write` :155) and the Store of the new attachment (mail ir_attachment.py:106-131, discuss/ir_attachment.py:22).
 *
 * The file goes to the database's FilestoreObject through src/filestore.ts writeFile.
 */
import { attachmentHasAccess } from '../models/ir_attachment_access';
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError, HttpResponseError, NotPorted, UserError } from '../errors';
import type { Handler } from '../http/context';
import { jsonRoute, route } from '../http/router';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { userFlags } from '../session/user';
import { limitedFieldAccessToken, htmlEscape } from '../models/util';
import { readFile, writeFile } from '../filestore';
import { contentDispositionAttachment } from '../controllers/export_csv';
import { extractFirstPage } from './pdf_first_page';
import { storeVersion } from '../bus/presence';
import { busSend } from './busnotify';
import { checkThread, permission } from './thread';
import { isGenericThread, permissionOn, postAccessOf } from './thread_generic';
import { write as ormWrite } from '../orm/write';
import { recordWritten } from '../orm/written_fields';
import { registerMethod } from '../http/methods';
import { envFor } from '../web/common';
import { pyTruthy } from '../models/util';
import { checkMoveUpload } from './move_import';
import { hasModelAccess } from '../web/groups';
import * as priv from "../orm/dispatch_gen";
import { guessType } from '../models/mimetypes';


/**
 * `_compute_mimetype(values)` (ir_attachment.py:469-489) for a name and its raw content: `mimetypes.guess_type(name)`
 * with the oracle's tables (src/models/mimetypes.ts), lowercased. When the name gives no type or
 * application/octet-stream, non-empty content goes to `guess_mimetype(raw)`, which is libmagic in the oracle's
 * interpreter (python-magic in .venv): that refuses. Empty content keeps the name's type or application/octet-stream.
 */
export function guessMimetype(name: string, raw: Uint8Array): string {
  const t = name ? guessType(name) : null;
  if (t && t !== 'application/octet-stream') return t.toLowerCase();
  if (raw.length) throw new NotPorted(`mimetype of ${name} from its content (guess_mimetype, libmagic)`);
  return t ?? 'application/octet-stream';
}

/**
 * `_check_contents` :547-555: an xml-like mimetype (html, xhtml, svg, xml; not the Office formats) becomes text/plain
 * when the context asks for it or the user may not write views (`ir.ui.view.sudo(False).has_access('write')`).
 */
export async function plainXml(env: Environment, mimetype: string): Promise<string> {
  const xmlLike = mimetype.includes('ht') || (mimetype.includes('xml') && !mimetype.startsWith('application/vnd.openxmlformats'));
  if (!xmlLike) return mimetype;
  return pyTruthy(env.context['attachments_mime_plainxml']) || !(await hasModelAccess(env, 'ir.ui.view', 'write')) ? 'text/plain' : mimetype;
}

/**
 * `_postprocess_contents` :492-530 with the default parameters: png, jpeg, bmp and tiff larger than 1920x1920 are
 * resized with PIL (not ported, refuses, as does a size the port cannot read); other types are kept. Configured
 * `base.image_autoresize_*` parameters refuse for any image.
 */
export async function checkImagePostprocess(env: Environment, mimetype: string, raw: Uint8Array): Promise<void> {
  const [type, subtype] = mimetype.split('/', 2);
  if (type !== 'image' || !raw.length) return;
  const icp = (await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key IN ('base.image_autoresize_extensions', 'base.image_autoresize_max_px')`)).rows;
  if (icp.length) throw new NotPorted('configured image autoresize parameters');
  if (!['png', 'jpeg', 'bmp', 'tiff'].includes(subtype ?? '')) return;
  const [w, h] = imageSize(raw, mimetype);
  if (w > 1920 || h > 1920) throw new NotPorted('image autoresize of uploads larger than 1920x1920');
}

/** Width and height from the PNG IHDR or a JPEG SOF marker (what PIL reads for `_postprocess_contents`). */
export function imageSize(data: Uint8Array, mimetype: string): [number, number] {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (mimetype === 'image/png') {
    if (data.length < 24 || dv.getUint32(0) !== 0x89504e47 || dv.getUint32(12) !== 0x49484452) throw new NotPorted('PNG without IHDR');
    return [dv.getUint32(16), dv.getUint32(20)];
  }
  if (mimetype === 'image/jpeg') {
    let i = 2;
    while (i + 9 < data.length) {
      if (data[i] !== 0xff) throw new NotPorted('JPEG marker parse');
      const marker = data[i + 1]!;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
      i += 2 + dv.getUint16(i + 2);
    }
    throw new NotPorted('JPEG without SOF');
  }
  throw new NotPorted(`image size of ${mimetype}`);
}

/** `_index` (ir_attachment.py:561): runs of 4+ printable ASCII bytes per `readline(8192)` line, joined by newlines. */
export function indexContent(data: Uint8Array, mimetype: string): string | null {
  if (!mimetype.startsWith('text/')) return null;
  const out: string[] = [];
  let start = 0;
  while (start < data.length) {
    // io readline(8192): up to and including the next newline, at most 8192 bytes
    let end = start;
    while (end < data.length && end - start < 8192) { end++; if (data[end - 1] === 0x0a) break; }
    let run = '';
    for (let i = start; i < end; i++) {
      const b = data[i]!;
      if (b >= 0x20 && b <= 0x7e) run += String.fromCharCode(b);
      else { if (run.length >= 4) out.push(run); run = ''; }
    }
    if (run.length >= 4) out.push(run);
    start = end;
  }
  return out.join('\n');
}

/** mail/controllers/attachment.py:63-111 `mail_attachment_upload`. */
const attachmentUpload: Handler = async ctx => {
  const form = ctx.form;
  if (!form) throw new NotPorted('attachment upload without a multipart body');
  const ufile = form.get('ufile');
  if (!ufile || typeof ufile === 'string') throw new NotPorted('attachment upload without a file');
  const model = String(form.get('thread_model') ?? ''), resIdRaw = String(form.get('thread_id') ?? '');
  const env = await ctx.orm();
  const generic = isGenericThread(model);
  const channel = model === 'discuss.channel';
  if ((model !== 'res.partner' && !generic && !channel) || !/^\d+$/.test(resIdRaw)) throw new NotPorted(`attachment upload on ${model}`);
  if (!(await userFlags(env.cr, env.uid)).isInternal) throw new NotPorted('attachment upload of non-internal users');
  for (const k of form.keys()) if (!['ufile', 'thread_id', 'thread_model', 'is_pending', 'csrf_token', 'tmp_url', 'temporary_id'].includes(k)) throw new NotPorted(`attachment upload parameter ${k}`);
  const resId = Number(resIdRaw);
  // attachment.py:65 `_get_thread_with_access_for_post`: `_mail_post_access` (write) on the document, read on
  // res.partner (mail/models/res_partner.py:19)
  if (channel) await checkChannelUpload(env, resId);
  else if (generic) {
    if (!(await permissionOn(env, model, resId, postAccessOf(model)))) throw new HttpError(404, '');
  } else {
    await checkThread(env, model, resId);
    if (!(await permission(env, resId, 'read'))) throw new HttpError(404, '');
  }
  const pendingRaw = form.get('is_pending');
  const pending = Boolean(pendingRaw) && pendingRaw !== 'false';
  // :72-81 company: the record's company, else the cookie's active companies (the user's company when in them)
  // `_mail_get_companies`: the record's company_id (mail_thread.py)
  const def = env.reg.model(model);
  let company = def.fields.get('company_id')?.column
    ? (await env.cr.query<{ company_id: number | null }>(`SELECT company_id FROM "${def.table}" WHERE id = $1`, [resId])).rows[0]?.company_id ?? null : null;
  if (company === null) {
    const cids = ctx.requestCookies.get('cids');
    if (cids) {
      const active = cids.split('-').map(Number);
      const userCompany = (await userInfo(env)).companyId;
      company = active.includes(userCompany) ? userCompany : active[0]!;
    } else company = await env.company(); // ir_attachment.py:595 default env.company
  }
  const name = ufile.name;
  const data = new Uint8Array(await ufile.arrayBuffer());
  // `ir.attachment.sudo().create` (attachment.py:96): `_check_contents` as the user for the view access (:551-554)
  const mimetype = await plainXml(env, guessMimetype(name, data));
  await checkImagePostprocess(env, mimetype, data);
  if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) throw new NotPorted('database attachment storage');
  // account ir_attachment.py:83-89 `_post_add_create`: the decoders of account.move (src/mail/move_import.ts); a
  // Peppol BIS 3 file is imported after the insert
  const ubl = model === 'account.move' && !pending ? await checkMoveUpload(env, resId, name, mimetype, data) : null;
  const hasMain = env.reg.model(model).fields.has('message_main_attachment_id');
  // a module's override of the main attachment refuses before anything is written
  if (hasMain && !pending && await priv.account_move._message_set_main_attachment_id.overriddenOn(env, model)) {
    throw new NotPorted(`the main attachment of ${model} with a module's _message_set_main_attachment_id`);
  }
  // :82-91 a composer upload is parked on mail.compose.message/0 until the message is posted
  const [attModel, attResId] = pending ? ['mail.compose.message', 0] : [model, resId];
  // create :934-938: an empty file has no `_get_datas_related_values` (no size, checksum, index or file)
  const checksum = data.length ? createHash('sha1').update(data).digest('hex') : null;
  const storeFname = checksum ? `${checksum.slice(0, 2)}/${checksum}` : null; // ir_attachment.py:140 _file_fname
  if (ctx.db === null) throw new NotPorted('upload without a database');
  const row = (await env.cr.query<{ id: number; create_date: string }>(
    `INSERT INTO ir_attachment (name, res_model, res_id, company_id, type, mimetype, file_size, checksum, store_fname,
       index_content, create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, $4, 'binary', $5, $6, $7, $8, $9, $10, $10, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')
     RETURNING id, to_char(create_date, 'YYYY-MM-DD HH24:MI:SS') AS create_date`,
    [name, attModel, attResId, company, mimetype, data.length ? data.length : null, checksum, storeFname, data.length ? indexContent(data, mimetype) : null, env.uid])).rows[0]!;
  if (storeFname) await writeFile(ctx.env, ctx.db, storeFname, data);
  // `_post_add_create` runs on the sudo attachment (attachment.py:98): the import as superuser; its
  // `rollbackable_transaction` commits, so the version keeps only what is written after it (src/models/ubl_import.ts)
  const imported = ubl ? await (await import('../models/ubl_import')).importBis3(env.sudo(), resId, row.id, ubl) : null;
  // mail ir_attachment.py:50-76 `_post_add_create` -> register_as_main_attachment(force=False) ->
  // mail_thread_main_attachment.py:22-47 `_message_set_main_attachment_id`: the first non-xml attachment becomes the
  // record's main one (as the user; an AccessError is suppressed)
  // the request's ORM writes, for the Store version's `written_fields_by_record` (mail/models/models.py `_flush`)
  const { written: registered } = await recordWritten(env, async () => {
    if (hasMain && !pending) {
      const current = (await env.cr.query<{ m: number | null }>(`SELECT message_main_attachment_id AS m FROM "${env.reg.model(model).table}" WHERE id = $1`, [resId])).rows[0]?.m ?? null;
      if (current === null && !mimetype.endsWith('xml') && !mimetype.endsWith('application/octet-stream') && mimetype !== 'message/rfc822') {
        if (await permissionOn(env, model, resId, 'write')) await ormWrite(env, model, [resId], { message_main_attachment_id: row.id });
      }
    }
  });
  const written = imported ? { ...imported, ...registered } : registered;
  const fieldsOut: Record<string, unknown> = { ...(await attachmentStoreFields(env, row.id)), ownership_token: await ownershipToken(env, row.id) };
  const attachment = Object.fromEntries(Object.entries(fieldsOut).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))); // Store sorts fields
  const store = { 'ir.attachment': [attachment], __store_version__: await storeVersion(env.cr, written) };
  return ctx.makeJsonResponse({ data: { store_data: store, attachment_id: row.id } });
};

/**
 * attachment.py:65 `_get_thread_with_access_for_post` on a discuss.channel: discuss_channel.py
 * `_mail_get_operation_for_mail_message_operation('create')` (not read-only, else the member's role) and `_mail_post_access`
 * read, which a member of the channel has (the channel rules). A read-only channel and a non-member refuse; a missing
 * channel is not found.
 */
async function checkChannelUpload(env: Environment, channelId: number): Promise<void> {
  const c = (await env.cr.query<{ is_readonly: boolean | null }>('SELECT is_readonly FROM discuss_channel WHERE id = $1', [channelId])).rows[0];
  if (!c) throw new HttpError(404, '');
  if (c.is_readonly) throw new NotPorted('attachment upload on a read-only channel');
  const self = await userInfo(env);
  if (!(await env.cr.query('SELECT 1 FROM discuss_channel_member WHERE channel_id = $1 AND partner_id = $2', [channelId, self.partnerId])).rows.length) {
    throw new NotPorted('attachment upload on a channel by a non-member (channel access rules)');
  }
}

// A refusal answers as the route answers its own refusal (attachment.py:108 `{"error": ...}`), which the chatter shows
// (attachment_upload_service.js:63-67); a 500 page shows only "Server error". The request is rolled back first
// (HttpResponseError, src/http/dispatch.ts).
route('/mail/attachment/upload', async (ctx, params) => {
  try {
    return await attachmentUpload(ctx, params);
  } catch (e) {
    if (e instanceof NotPorted) throw new HttpResponseError(ctx.makeJsonResponse({ error: e.message }));
    throw e;
  }
}, { auth: 'public', methods: ['POST'] });

/** mail ir_attachment.py:56-76 `register_as_main_attachment`, `_message_set_main_attachment_id` (mail_thread_main_attachment.py:22-47) for one attachment per record. */
registerMethod('ir.attachment', 'register_as_main_attachment', async (env0, ids, args, kwargs0) => {
  const { env } = envFor(env0, kwargs0);
  const force = pyTruthy(kwargs0['force'] ?? args[0] ?? true);
  if (!ids?.length) return null;
  const rows = (await env.cr.query<{ id: number; res_model: string | null; res_id: number | null; mimetype: string | null }>(
    'SELECT id, res_model, res_id, mimetype FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows.filter((r) => r.res_model && r.res_id);
  for (const a of rows) {
    const model = a.res_model!;
    if (!env.reg.models.has(model) || !env.reg.model(model).fields.has('message_main_attachment_id')) return null; // no such method: :69-70 returns
    if (await priv.account_move._message_set_main_attachment_id.overriddenOn(env, model)) throw new NotPorted(`register_as_main_attachment on ${model} with a module's _message_set_main_attachment_id`);
    const mimetype = a.mimetype ?? '';
    if (mimetype.endsWith('xml') || mimetype.endsWith('application/octet-stream') || mimetype === 'message/rfc822') continue;
    const current = (await env.cr.query<{ m: number | null }>(`SELECT message_main_attachment_id AS m FROM "${env.reg.model(model).table}" WHERE id = $1`, [a.res_id])).rows[0]?.m ?? null;
    if ((force || current === null) && await permissionOn(env, model, a.res_id!, 'write')) await ormWrite(env, model, [a.res_id!], { message_main_attachment_id: a.id });
  }
  return null;
}, { apiModel: false });

/** `_get_ownership_token` (mail ir_attachment.py:119). */
export function ownershipToken(env: Environment, id: number): Promise<string> {
  return limitedFieldAccessToken(env, 'ir.attachment', id, 'id', 'attachment_ownership');
}

/**
 * `_store_attachment_fields` (mail ir_attachment.py:109-117 and discuss/ir_attachment.py:22-25): no voice metadata
 * is ported (refuses when present).
 */
export async function attachmentStoreFields(env: Environment, id: number): Promise<Record<string, unknown>> {
  const a = (await env.cr.query<{ checksum: string | null; create_date: string; file_size: number | null; mimetype: string | null; name: string;
    res_model: string | null; res_id: number | null; type: string; url: string | null; thumb: boolean }>(
    `SELECT checksum, to_char(create_date, 'YYYY-MM-DD HH24:MI:SS') AS create_date, file_size, mimetype, name, res_model, res_id, type, url,
            EXISTS (SELECT 1 FROM ir_attachment t WHERE t.res_model = 'ir.attachment' AND t.res_field = 'thumbnail' AND t.res_id = a.id AND COALESCE(t.file_size, 0) > 0) AS thumb
       FROM ir_attachment a WHERE id = $1`, [id])).rows[0];
  if (!a) throw new NotPorted('attachment Store of a missing attachment');
  if ((await env.cr.query('SELECT 1 FROM discuss_voice_metadata WHERE attachment_id = $1', [id])).rows.length) throw new NotPorted('voice attachments');
  let resName: string | false = false, thread: unknown = false;
  if (a.res_model && a.res_id) {
    // ir_attachment.py _compute_res_name: the record's display_name (sudo), for the ported thread models
    if (a.res_model === 'mail.message') {
      // mail_message.py:156 `_rec_name = 'subject'`: the message's subject is its display name
      const m = (await env.cr.query<{ subject: string | null }>('SELECT subject FROM mail_message WHERE id = $1', [a.res_id])).rows[0];
      if (!m?.subject) throw new NotPorted('attachment res_name on a message without subject');
      resName = m.subject;
    } else if (a.res_model === 'discuss.channel') {
      // discuss_channel.py:250-263 `_compute_display_name`: the name, else the members' names (not ported)
      const ch = (await env.cr.query<{ name: string | null }>('SELECT name FROM discuss_channel WHERE id = $1', [a.res_id])).rows[0];
      if (!ch?.name) throw new NotPorted('attachment res_name on a channel without name');
      resName = ch.name;
    } else {
      if (a.res_model !== 'res.partner' && !isGenericThread(a.res_model)) throw new NotPorted(`attachment res_name on ${a.res_model}`);
      resName = (await env.sudo().model(a.res_model).displayName([a.res_id])).get(a.res_id) ?? false;
    }
  }
  // :115 the thread, unless the attachment only lives on its message (the predicate leaves the key out); a composer
  // upload has none (res_id 0)
  if (a.res_model && a.res_model !== 'mail.message' && a.res_id) thread = { id: a.res_id, model: a.res_model };
  return {
    checksum: a.checksum ?? false, create_date: a.create_date, file_size: a.file_size ?? 0, has_thumbnail: a.thumb, id,
    mimetype: a.mimetype ?? false, name: a.name,
    raw_access_token: await limitedFieldAccessToken(env, 'ir.attachment', id, 'raw', 'binary'),
    res_model: a.res_model ?? false, res_name: resName, ...(a.res_model === 'mail.message' ? {} : { thread }),
    thumbnail_access_token: await limitedFieldAccessToken(env, 'ir.attachment', id, 'thumbnail', 'binary'),
    type: a.type, url: a.url ?? false, voice_ids: [],
  };
}

function safeTokenEqual(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function renderTextAttachmentHtml(bytes: Uint8Array, mimetype: string, head: boolean): string {
  let content = new TextDecoder('utf-8').decode(head ? bytes.slice(0, 4096) : bytes);
  if (mimetype === 'application/json' && !head) {
    try {
      content = JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      // invalid JSON: render raw decoded text
    }
  }
  return '\n        <html>\n            <body style="background-color: #ffffff; color: #212529;">\n                <div class="wrap">\n'
    + `                    <pre style="white-space: pre-wrap; word-wrap: break-word; margin: 0; font-family: monospace;">${htmlEscape(content)}</pre>\n`
    + '                </div>\n            </body>\n        </html>';
}

const TEXT_TYPES = ['application/javascript', 'application/json', 'application/xml', 'text/css', 'text/csv', 'text/html', 'text/markdown', 'text/plain', 'text/xml'];

/** `/mail/attachment/render_text/<id>` (attachment.py:226, `_render_text_attachment` :274, template mail.content_text). */
route('/mail/attachment/render_text/<int:attachment_id>', async (ctx, params) => {
  const env = await ctx.orm();
  const id = Number(params['attachment_id']);
  const q = ctx.url.searchParams;
  const a = (await env.cr.query<{ mimetype: string | null; checksum: string | null; store_fname: string | null; res_model: string | null; res_id: number | null; res_field: string | null; type: string }>(
    'SELECT mimetype, checksum, store_fname, res_model, res_id, res_field, type FROM ir_attachment WHERE id = $1', [id])).rows[0];
  if (!a) throw new HttpError(404, '');
  // ir.binary._find_record(access_token, field='raw'): the scoped raw token, else read access (internal user, partner thread)
  const token = q.get('access_token');
  const ok = safeTokenEqual(token, await limitedFieldAccessToken(env, 'ir.attachment', id, 'raw', 'binary'));
  if (!ok) {
    if (a.res_field || a.res_model !== 'res.partner' || !a.res_id || !(await userFlags(env.cr, env.uid)).isInternal || !(await permission(env, a.res_id, 'read'))) {
      throw new NotPorted('render_text access without the raw token');
    }
  }
  const mimetype = a.mimetype ?? '';
  if (!TEXT_TYPES.includes(mimetype)) throw new HttpError(400, '');
  const head = ['1', 'true', 'True', 't', 'y', 'yes', 'on'].includes(q.get('head') ?? '');
  if (a.type !== 'binary' || !a.store_fname) throw new NotPorted('render_text of url or database attachments');
  const bytes = await readFile(ctx.env, env.cr.db, a.store_fname);
  if (bytes === null) throw new NotPorted('render_text of a missing filestore file');
  const unique = q.get('unique');
  const immutable = Boolean(unique) && unique === a.checksum;
  const html = renderTextAttachmentHtml(bytes, mimetype, head);
  // :251-262 _set_render_with_headers
  return new Response(html, { status: 200, headers: {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; sandbox;",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': immutable ? 'private, immutable, max-age=31536000' : 'private',
  } });
}, { auth: 'public', methods: ['GET'], readonly: true });

/** `odoo.tools.mimetypes.guess_mimetype` for the image signatures thumbnails use (JPEG, PNG); others refuse. */
export function guessContentMimetype(data: Uint8Array): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && Buffer.from(data.subarray(0, 8)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  throw new NotPorted('guess_mimetype of thumbnail content');
}

/**
 * `/mail/attachment/pdf_first_page/<id>` (attachment.py:166-183, `_get_pdf_first_page_response` :210-224): the first
 * page as PyPDF2 writes it (src/mail/pdf_first_page.ts), for a PDF the user may read or owns (ownership token).
 */
route('/mail/attachment/pdf_first_page/<int:attachment_id>', async (ctx, params) => {
  const env = await ctx.orm();
  const id = Number(params['attachment_id']);
  const a = (await env.cr.query<{ name: string | null; mimetype: string | null; store_fname: string | null; res_model: string | null; res_id: number | null; res_field: string | null; type: string }>(
    'SELECT name, mimetype, store_fname, res_model, res_id, res_field, type FROM ir_attachment WHERE id = $1', [id])).rows[0];
  if (!a) throw new HttpError(404, ''); // :178-183 not_found for missing attachments (the client asks for -2 first)
  const token = ctx.url.searchParams.get('access_token');
  const owned = safeTokenEqual(token, await ownershipToken(env, id));
  if (!owned && !(await attachmentHasAccess(env, id, 'read'))) throw new HttpError(404, ''); // :177-181 not_found
  // tools/pdf to_pdf_stream (:185-199): `_get_pdf_raw` for binary PDFs; images are converted by Pillow (not ported)
  if (a.mimetype?.startsWith('image')) throw new NotPorted('pdf_first_page of an image (Pillow PDF conversion)');
  if (a.type !== 'binary' || !a.mimetype?.startsWith('application/pdf')) throw new HttpError(415, 'Unsupported Media Type');
  if (!a.store_fname) throw new NotPorted('pdf_first_page of a database-stored attachment');
  const raw = await readFile(ctx.env, env.cr.db, a.store_fname);
  if (raw === null || raw.length === 0) throw new HttpError(415, 'Unsupported Media Type');
  const content = extractFirstPage(raw);
  const headers: [string, string][] = [
    ['Content-Type', 'attachment/pdf'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Content-Length', String(content.length)],
  ];
  if (a.name) headers.push(['Content-Disposition', contentDispositionAttachment(a.name)]);
  return new Response(content, { status: 200, headers });
}, { auth: 'public', methods: ['GET'], readonly: true });

/**
 * `/mail/attachment/update_thumbnail` (attachment.py:186): the client's rendering stored as the attachment's
 * `thumbnail` Image field (an attachment of the attachment, res_field "thumbnail"; Image without max size keeps the
 * bytes, fields_binary.py `_image_process`), and the Store bus notification of `has_thumbnail` to the user.
 */
jsonRouteThumbnail();
function jsonRouteThumbnail(): void {
  jsonRoute('/mail/attachment/update_thumbnail', async ctx => {
    const p = ctx.jsonParams ?? {};
    const env = await ctx.orm();
    const id = Number(p['attachment_id']);
    const a = (await env.cr.query<{ mimetype: string | null; res_model: string | null; res_id: number | null; res_field: string | null; company_id: number | null }>(
      'SELECT mimetype, res_model, res_id, res_field, company_id FROM ir_attachment WHERE id = $1', [id])).rows[0];
    if (!a) throw new HttpError(404, '');
    const token = p['access_token'];
    const owned = typeof token === 'string' && safeTokenEqual(token, await ownershipToken(env, id));
    // :193-197 not found unless the user may write the attachment (ir.attachment access of its record) or owns it
    if (!owned && !(await attachmentHasAccess(env, id, 'write'))) throw new HttpError(404, '');
    if (a.mimetype !== 'application/pdf' && !a.mimetype?.startsWith('video/')) throw new UserError('Only PDF and videos files can have thumbnail.');
    if (typeof p['thumbnail'] !== 'string' || !p['thumbnail']) throw new NotPorted('default unknown.svg thumbnail');
    const data = new Uint8Array(Buffer.from(p['thumbnail'], 'base64'));
    const mimetype = guessContentMimetype(data);
    const [w, h] = imageSize(data, mimetype);
    if (w * h > 50e6) throw new NotPorted('thumbnail resolution check (IMAGE_MAX_RESOLUTION)');
    const existing = (await env.cr.query(`SELECT 1 FROM ir_attachment WHERE res_model = 'ir.attachment' AND res_field = 'thumbnail' AND res_id = $1`, [id])).rows.length;
    if (existing) throw new NotPorted('replacing an existing thumbnail');
    const checksum = createHash('sha1').update(data).digest('hex');
    const storeFname = `${checksum.slice(0, 2)}/${checksum}`;
    if (ctx.db === null) throw new NotPorted('thumbnail without a database');
    // fields_binary.py attachment=True: ir.attachment(name=field, res_model, res_field, res_id, raw) as superuser
    await env.cr.query(
      `INSERT INTO ir_attachment (name, res_model, res_field, res_id, company_id, type, mimetype, file_size, checksum, store_fname,
         create_uid, write_uid, create_date, write_date)
       VALUES ('thumbnail', 'ir.attachment', 'thumbnail', $1, $2, 'binary', $3, $4, $5, $6, $7, $7, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC')`,
      [id, await env.company(), mimetype, data.length, checksum, storeFname, env.uid]);
    await writeFile(ctx.env, ctx.db, storeFname, data);
    // BaseModel.write of the thumbnail on the attachment: its write_date (and write_uid) change
    await env.cr.query(`UPDATE ir_attachment SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [id, env.uid]);
    // :208 Store(bus_channel=attachment).add(attachment, ["has_thumbnail"]): the attachment's bus channels are the
    // user's (bus ir_attachment.py:10-11; discuss ir_attachment.py:12-19 for channels and guests)
    if (a.res_model === 'discuss.channel' || (await userFlags(env.cr, env.uid)).isPublic) throw new NotPorted('has_thumbnail bus notification of a channel or guest attachment');
    const payload = {
      'ir.attachment': [{ has_thumbnail: true, id }],
      __store_version__: await storeVersion(env.cr, { 'ir.attachment': { [String(id)]: ['write_date'] } }),
    };
    await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.record/insert', payload);
    return null;
  }, { auth: 'public' });
}

/** Werkzeug's int converter does not match `-2` (the client asks for the not-yet-uploaded temporary id): no route,
 * hence the plain NotFound page (odoo/odoo/http/router.py). */
route('/mail/attachment/pdf_first_page/<string:attachment_id>', async (_ctx, params) => {
  if (/^\d+$/.test(params['attachment_id'] ?? '')) throw new NotPorted('pdf_first_page route order');
  throw new HttpError(404, '');
}, { auth: 'public', methods: ['GET'], readonly: true });
