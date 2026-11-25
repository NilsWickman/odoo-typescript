/**
 * Files attached to an account.move from its chatter, and what Odoo does with them beyond linking them:
 *  - posted with a message (`/mail/message/post`): account_move.py:7997-8067 `_message_post_after_hook` (comment or
 *    email messages with attachments, without `disable_attachment_import`): the files that belong on the record stay on
 *    it, the others are detached from it (`_fix_attachments_on_record_from_files_data`,
 *    account_document_import_mixin.py:381-406), then the decoders run for an active internal user
 *    (`_extend_with_attachments`, :287-359 and account_move.py:5015-5057); after it mail_thread_main_attachment.py:17-47
 *    picks the record's main attachment among the message's files;
 *  - uploaded to the record itself (`/mail/attachment/upload` without `is_pending`): account ir_attachment.py:83-89
 *    `_post_add_create` runs the same decoders.
 *
 * The decoders are not ported. Which one runs is decided by the file alone, not by the move: the importable files are
 * XML trees whose type account_edi_ubl_cii account_move.py:214-242 recognises (UBL, CII, a UBL AttachedDocument),
 * also when embedded in a PDF (`_unwrap_attachment`, account_document_import_mixin.py:500-528, odoo/tools/pdf
 * `get_attachments`). On any move the decoder then changes something: an empty move of a sale or purchase journal is
 * filled (account_edi_common.py:582-640), a move with lines gets the message "not imported: the invoice already
 * contains lines", and on a move of another journal the decoder returns as if it succeeded, which stores the file as
 * `import_source_attachment_id`. So the port refuses the files a decoder may take: every XML file (what `_get_xml_tree`
 * would parse, :468-488) and every PDF that may embed files. Ordinary files (PDF without embedded files, images,
 * office documents, text) are handled as Odoo does.
 *
 * `_extend_with_attachments` also runs `_post_process_link_to_purchase_order` for every file (account_move.py:5055;
 * account_edi_ubl_cii account_move.py:185-208), which may group the lines of a draft move that has a UBL/CII file of
 * its own: refused.
 */
import { inflateSync } from 'node:zlib';
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { readFile } from '../filestore';
import { attachmentHasAccess } from '../models/ir_attachment_access';
import { write as ormWrite } from '../orm/write';
import { recordWritten } from '../orm/written_fields';
import type { Element } from '../xml';
import * as priv from "../orm/dispatch_gen";

type WorkerEnv = Parameters<typeof readFile>[0];
type Written = Record<string, Record<string, string[]>>;

/** account_document_import_mixin.py:388-406 `_should_attach_to_record`: the mimetypes kept on the record. */
const KEPT = new Set([
  'text/csv',
  'application/pdf',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.oasis.opendocument.presentation',
]);

const latin1 = new TextDecoder('latin1');

/** Whether the name /EmbeddedFiles occurs in PDF text, also written with `#xx` escapes (PDF 1.7 7.3.5). */
function namesEmbeddedFiles(s: string): boolean {
  if (s.includes('/EmbeddedFiles')) return true;
  for (const m of s.matchAll(/\/([^\s/[\]<>(){}%]*#[^\s/[\]<>(){}%]*)/g)) {
    const decoded = m[1]!.replace(/#([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    if (decoded === 'EmbeddedFiles') return true;
  }
  return false;
}

/**
 * Whether a PDF may have embedded files for odoo/tools/pdf `get_attachments` (:325-351): it reads them from the
 * catalog's /Names /EmbeddedFiles, so the name is in the file, either as text or inside an object stream. Object
 * streams are inflated (FlateDecode without parameters); any other object stream, or one that does not inflate (an
 * encrypted file), counts as may. A superset of what Odoo unwraps: false means it finds nothing.
 */
export function pdfMayEmbedFiles(data: Uint8Array): boolean {
  const s = latin1.decode(data);
  if (namesEmbeddedFiles(s)) return true;
  if (!/\/Type\s*\/ObjStm/.test(s)) return false;
  for (const m of s.matchAll(/\bobj\b([\s\S]*?)\bstream(\r\n|\r|\n)/g)) {
    const dict = m[1]!;
    if (!/\/Type\s*\/ObjStm\b/.test(dict)) continue;
    if (!/\/Filter\b/.test(dict)) continue; // an uncompressed object stream: its text is in `s` already
    const filter = /\/Filter\s*(?:\/(\w+)|\[\s*((?:\/\w+\s*)*)\])/.exec(dict);
    const names = filter === null ? [] : filter[1] ? [filter[1]] : filter[2]!.trim().split(/\s+/).filter(Boolean).map(n => n.slice(1));
    if (names.length !== 1 || names[0] !== 'FlateDecode' || /\/DecodeParms/.test(dict)) return true;
    const start = m.index! + m[0].length;
    const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    const end = direct ? start + Number(direct[1]) : s.indexOf('endstream', start);
    if (end < start || end > data.length) return true;
    let inner: Uint8Array;
    try {
      inner = inflateSync(data.subarray(start, end));
    } catch {
      try {
        // a /Length given indirectly: the data up to `endstream` ends with the end-of-line before it
        inner = inflateSync(data.subarray(start, end).subarray(0, Math.max(0, end - start - 2)));
      } catch {
        return true;
      }
    }
    if (namesEmbeddedFiles(latin1.decode(inner))) return true;
  }
  return false;
}

/** The content starts like XML: `<` after an optional byte order mark and whitespace. */
function looksXml(data: Uint8Array): boolean {
  let i = 0;
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) i = 3;
  else if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return true; // UTF-16
  while (i < data.length && (data[i] === 0x20 || data[i] === 0x09 || data[i] === 0x0a || data[i] === 0x0d)) i++;
  return data[i] === 0x3c;
}

/**
 * Why a decoder of account.move may take the file (the refusal's reason), or null when none does:
 *  - XML: account_document_import_mixin.py:468-488 `_get_xml_tree` parses a file whose mimetype ends with `/xml`, or a
 *    `text/plain` one named `.xml` or whose content libmagic calls XML (here: content starting with `<`);
 *  - PDF: `_get_import_file_type` (:442-446) calls a file PDF when its mimetype contains `pdf` or its name ends with
 *    `.pdf`, and `_unwrap_attachment` (:500-528) decodes its embedded files.
 */
export function moveDecoderFile(name: string, mimetype: string, data: Uint8Array | null): string | null {
  if (isXmlFile(name, mimetype, data)) return `an XML file (${mimetype}) on an invoice, which the EDI decoders read`;
  if (mimetype.includes('pdf') || name.endsWith('.pdf')) {
    if (data === null) throw new NotPorted('a PDF on an invoice whose content the port cannot read');
    if (pdfMayEmbedFiles(data)) return 'a PDF with embedded files (Factur-X, ZUGFeRD, ...) on an invoice, which the EDI decoders unwrap';
  }
  return null;
}

/**
 * Whether `_get_xml_tree` (account_document_import_mixin.py:468-488) parses the file: a mimetype ending with `/xml`, or
 * `text/plain` named `.xml` or with content libmagic calls XML (here: content starting with `<`).
 */
export function isXmlFile(name: string, mimetype: string, data: Uint8Array | null): boolean {
  if (mimetype.endsWith('/xml')) return true;
  if (!mimetype.includes('text/plain')) return false;
  if (name.endsWith('.xml')) return true;
  if (data === null) throw new NotPorted('a text file on an invoice whose content the port cannot read');
  return looksXml(data);
}

/** Whether the file's content is needed to tell (moveDecoderFile reads it). */
function needsContent(name: string, mimetype: string): boolean {
  return mimetype.includes('text/plain') || mimetype.endsWith('/xml') || mimetype.includes('pdf') || name.endsWith('.pdf');
}

/**
 * account_edi_ubl_cii account_move.py:185-208 `_post_process_link_to_purchase_order`, run by every
 * `_extend_with_attachments` on a move: on a draft with a partner, two lines or more (or grouped lines) and a UBL/CII
 * file of its own (`ubl_cii_xml_id`), it may group the lines by tax. Refused there; elsewhere it does nothing.
 */
async function assertNoLinkPostProcess(env: Environment, moveId: number): Promise<void> {
  const r = (await env.cr.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM account_move m
      WHERE m.id = $1 AND m.state = 'draft' AND m.partner_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM ir_attachment a WHERE a.res_model = 'account.move' AND a.res_id = m.id AND a.res_field = 'ubl_cii_xml_file')`,
    [moveId])).rows[0];
  if (Number(r?.n ?? 0) > 0) throw new NotPorted('a file on a draft invoice with a UBL/CII file of its own (_post_process_link_to_purchase_order)');
}

/**
 * A module's override of how the import reads a file or picks its decoder changes what happens to a file beyond
 * moveDecoderFile and the BIS 3 import (src/models/ubl_import.ts): l10n_it_edi's `_get_xml_tree` (signed .p7m files,
 * XML parsed with recovery) and `_unwrap_attachment` (a FatturaPA split into invoices); l10n_ro_edi's, l10n_dk's,
 * l10n_it_edi's and l10n_sg_ubl_pint's `_get_import_file_type` (a CIUS-RO file, which bis3Tree would take as BIS 3,
 * goes to their own decoder); l10n_hu_edi's and l10n_it_edi's `_get_edi_decoder`. Every file on an invoice refuses
 * where one is installed.
 */
async function refuseWidenedImport(env: Environment): Promise<void> {
  for (const h of [priv.account_move._get_xml_tree, priv.account_move._unwrap_attachment, priv.account_move._get_import_file_type, priv.account_move._get_edi_decoder]) {
    if (await h.overridden(env)) throw new NotPorted(`a file on an invoice with a module's ${h.name} (the EDI import)`);
  }
}

/**
 * `/mail/attachment/upload` of a file to an account.move itself (account ir_attachment.py:83-89), before the insert:
 * a Peppol BIS 3 file gives the tree the caller imports after the insert (`importBis3`, src/models/ubl_import.ts);
 * other files a decoder may take refuse, the others run only the post-process.
 */
export async function checkMoveUpload(env: Environment, moveId: number, name: string, mimetype: string, data: Uint8Array): Promise<Element | null> {
  await refuseWidenedImport(env);
  // loaded when used: src/models/ubl_import.ts imports mail modules that import this one
  if (isXmlFile(name, mimetype, data)) return (await import('../models/ubl_import')).bis3Tree(data);
  const reason = moveDecoderFile(name, mimetype, data);
  if (reason !== null) throw new NotPorted(reason);
  await assertNoLinkPostProcess(env, moveId);
  return null;
}

interface AttRow {
  id: number; name: string | null; mimetype: string | null; res_model: string | null; res_id: number | null;
  res_field: string | null; type: string | null; store_fname: string | null;
}

/**
 * After the message is created and its author follows (mail_thread.py:2430-2447), before `_notify_thread`: the
 * `_message_post_after_hook` of account.move and of mail.thread.main.attachment for the message's files. Records the
 * fields written in `written` (the Store version's `written_fields_by_record`).
 */
export async function messagePostAfterHook(workerEnv: WorkerEnv, env: Environment, model: string, resId: number, messageId: number,
  attachmentIds: readonly number[], written: Written): Promise<void> {
  if (!attachmentIds.length) return;
  const rows = (await env.cr.query<AttRow>(
    'SELECT id, name, mimetype, res_model, res_id, res_field, type, store_fname FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id',
    [[...attachmentIds]])).rows;
  if (model === 'account.move') {
    if (env.context['from_alias']) throw new NotPorted('a message posted on an invoice from a mail alias');
    if (!env.context['disable_attachment_import']) {
      await refuseWidenedImport(env);
      const detach: number[] = [];
      let ubl: { id: number; tree: Element } | null = null;
      for (const a of rows) {
        const name = a.name ?? '', mimetype = a.mimetype ?? '';
        if (a.type !== 'binary') throw new NotPorted(`an attachment of type ${a.type} posted on an invoice`);
        let data: Uint8Array | null = null;
        if (needsContent(name, mimetype)) {
          if (a.store_fname === null) throw new NotPorted('an attachment stored in the database posted on an invoice');
          data = await readFile(workerEnv, env.cr.db, a.store_fname);
        }
        // a Peppol BIS 3 file (src/models/ubl_import.ts), alone: with other files `_get_selected_import_file_data`
        // chooses among them and the main attachment follows (step 1 of the import does not port it)
        if (isXmlFile(name, mimetype, data)) {
          if (rows.length !== 1) throw new NotPorted('a UBL file posted with other files');
          if (data === null) throw new NotPorted('a UBL file whose content the port cannot read');
          ubl = { id: a.id, tree: (await import('../models/ubl_import')).bis3Tree(data) };
          // :381-386: an XML tree is kept on the record (the composer's upload is already on it)
          if (a.res_field || a.res_model !== model || a.res_id !== resId) throw new NotPorted('posting on an invoice a UBL file of another record');
          continue;
        }
        const reason = moveDecoderFile(name, mimetype, data);
        if (reason !== null) throw new NotPorted(reason);
        // :381-386: kept files move to the record, the others are detached from any account.move
        if (!a.res_field && KEPT.has(mimetype)) {
          if (a.res_model !== model || a.res_id !== resId) throw new NotPorted('posting on an invoice a file of another record');
        } else if (a.res_model === model && !a.res_field) {
          detach.push(a.id);
        }
      }
      // ir_attachment.py:878-897 write: write access on each attachment; res_model False and res_id 0 skip the
      // comodel check (both falsy); account ir_attachment.py:39-53 checks the audit trail of PDF and XML files only
      for (const aid of detach) {
        if (!(await attachmentHasAccess(env, aid, 'write'))) throw new NotPorted('detaching an attachment the user cannot write');
      }
      if (detach.length) {
        await env.cr.query(`UPDATE ir_attachment SET res_model = NULL, res_id = 0, write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])`, [detach, env.uid]);
        // the fields in ir.attachment's order, as post.ts lists them for `_process_attachments_for_post`
        for (const aid of detach) (written['ir.attachment'] ??= {})[String(aid)] = ['res_model', 'res_id', 'write_uid', 'write_date'];
      }
      // :8059-8061 the decoders run for an active internal user (the port's posters are internal); with no decoder
      // for any file `_extend_with_attachments` only runs the post-process
      if (ubl) {
        const after = await (await import('../models/ubl_import')).importBis3(env, resId, ubl.id, ubl.tree);
        // `rollbackable_transaction` committed: the version keeps what is written after it (importBis3), then :8065
        // `new_message.attachment_ids = [Command.set(...)]` writes the message, whose write_uid and write_date the
        // commit left out of the cache (both listed, measured in vagb_move_ubl)
        for (const k of Object.keys(written)) delete written[k];
        Object.assign(written, after);
        await env.cr.query(`UPDATE mail_message SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [messageId, env.uid]);
        written['mail.message'] = { [String(messageId)]: ['write_uid', 'write_date'] };
      } else await assertNoLinkPostProcess(env, resId);
    }
  }
  // mail_thread_main_attachment.py:17-47: as superuser, when the record has none: a PDF first, then an image, then any
  // other file, xml, octet-stream and rfc822 files left out; `max` keeps the first of equal ones in the order of
  // `message.attachment_ids`, which the port does not reproduce: several candidates of the best kind refuse
  if (!env.reg.models.has(model) || !env.reg.model(model).fields.has('message_main_attachment_id')) return;
  // a module's `_message_set_main_attachment_id` (l10n_it: force over a .p7m main attachment) refuses
  if (await priv.account_move._message_set_main_attachment_id.overriddenOn(env, model)) throw new NotPorted(`the main attachment of ${model} with a module's _message_set_main_attachment_id`);
  const table = env.reg.model(model).table;
  const current = (await env.cr.query<{ m: number | null }>(`SELECT message_main_attachment_id AS m FROM "${table}" WHERE id = $1`, [resId])).rows[0]?.m ?? null;
  if (current !== null) return;
  const candidates = rows.filter(a => {
    const m = a.mimetype ?? '';
    return !m.endsWith('xml') && !m.endsWith('application/octet-stream') && m !== 'message/rfc822';
  });
  if (!candidates.length) return;
  const rank = (a: AttRow): number => ((a.mimetype ?? '').endsWith('pdf') ? 2 : 0) + ((a.mimetype ?? '').startsWith('image') ? 1 : 0);
  const best = Math.max(...candidates.map(rank));
  const top = candidates.filter(a => rank(a) === best);
  if (top.length > 1) throw new NotPorted('the main attachment among several files of the same kind');
  // fields.py `_filter_not_equal`: a write_uid equal to the cached one (the poster's) is not dirty, so the version
  // leaves it out (as src/mail/channel_post.ts does for a member; measured in vagb_move_files)
  const uidBefore = (await env.cr.query<{ u: number | null }>(`SELECT write_uid AS u FROM "${table}" WHERE id = $1`, [resId])).rows[0]?.u ?? null;
  const { written: w } = await recordWritten(env, () => ormWrite(env.sudo(), model, [resId], { message_main_attachment_id: top[0]!.id }));
  for (const [m, byId] of Object.entries(w)) {
    for (const [rid, fields] of Object.entries(byId)) {
      if (written[m]?.[rid]) throw new NotPorted(`the written fields of ${m} ${rid} from two writes`);
      (written[m] ??= {})[rid] = m === model && rid === String(resId) && uidBefore === env.uid ? fields.filter(f => f !== 'write_uid') : fields;
    }
  }
}
