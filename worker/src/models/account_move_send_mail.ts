/**
 * The mail of the invoice send wizard for a move that already has its PDF (account/models/account_move_send.py):
 * `_generate_and_send_invoices` (:850-897) renders nothing then (:735-737 `not invoice.invoice_pdf_report_id`), links
 * nothing (:466-485), and `_hook_if_success` (:499-528) -> `_send_mails` (:672-711) -> `_send_mail` (:555-582) posts the
 * wizard's subject and body on the move to the chosen partners with a copy of the PDF (`message_post` with
 * `attachments`, mail_thread.py:2256-2449 and `_process_attachments_for_post` :2468-2606), whose notification gives the
 * customer the portal_customer group's signed link (src/mail/notify.ts). The copy is then moved onto the message.
 * Refused before anything is written: other sending methods, dynamic reports, template reply-to and attachments,
 * journal invoice subscribers, Peppol companies, EDI files, xml-like or image attachments, alias domains.
 */
import { createHash } from "node:crypto";
import { NotPorted } from "../errors";
import { requestOfCursor } from "../http/context";
import type { Environment } from "../orm/types";
import { userInfo } from "../orm/env";
import { write as ormWrite } from "../orm/write";
import { sanitizeHtml } from "../orm/write_values";
import { readFile, writeFile } from "../filestore";
import { renderTemplateField } from "../qweb/mail_render";
import { insertMessages, trackingMessageId, xmlid } from "../mail/message";
import { messageSubscribe } from "../mail/followers";
import { emailSplitTuples, flatThreadParent } from "../mail/thread_generic";
import { indexContent } from "../mail/attachment";
import { notifyThread } from "../mail/notify";
import { emailNormalize } from "../mail/message";
import { guessType } from "./mimetypes";
import { pySetOrder } from "./pyset";
import { cond } from "../orm/domain";
import { translateLang } from "./util";
import * as priv from "../orm/dispatch_gen";

export interface SendSettings {
  move: number;
  company: number;
  partner: number;
  journal: number;
  moveType: string;
  template: number | null;
  lang: string | null;
  body: string | null;
  subject: string | null;
  partnerIds: number[];
  widget: Record<string, unknown>[];
}

/** account_move_send.py:589-623 `_get_mail_params` attachments: the PDF (extra attachments) and the widget's ids. */
async function mailAttachments(env: Environment, s: SendSettings): Promise<{ name: string; data: Uint8Array }[]> {
  const extra = (await env.cr.query<{ id: number; name: string }>(
    "SELECT id, name FROM ir_attachment WHERE res_model = 'account.move' AND res_id = $1 AND res_field = 'invoice_pdf_report_file' ORDER BY id LIMIT 1", [s.move])).rows;
  const skip = new Set(s.widget.filter((x) => x["skip"]).map((x) => String(x["name"])));
  const seen: number[] = [];
  for (const a of [...extra.map((r) => ({ id: r.id, name: r.name } as Record<string, unknown>)), ...s.widget]) {
    if (skip.has(String(a["name"])) && !a["manual"]) continue;
    const id = a["id"];
    // `int(attachment_data['id'])`: placeholders ('placeholder_...') are skipped
    const n = typeof id === "number" ? id : typeof id === "string" && /^\s*[-+]?\d+\s*$/.test(id) ? Number(id) : null;
    if (n === null) continue;
    if (!seen.includes(n)) seen.push(n);
  }
  const out: { name: string; data: Uint8Array }[] = [];
  const ctx = requestOfCursor(env.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("invoice mail attachments outside a request");
  // `browse(list(seen_attachment_ids)).exists()`: CPython's set order
  for (const id of pySetOrder(seen)) {
    const r = (await env.cr.query<{ name: string; store_fname: string | null; db_datas: Buffer | null; type: string }>(
      "SELECT name, store_fname, db_datas, type FROM ir_attachment WHERE id = $1", [id])).rows[0];
    if (!r) continue;
    if (r.type !== "binary") throw new NotPorted("url attachment in the invoice mail");
    const data = r.store_fname ? await readFile(ctx.env, ctx.db, r.store_fname) : r.db_datas ? new Uint8Array(r.db_datas) : new Uint8Array();
    if (data === null) throw new NotPorted("invoice mail attachment missing from the filestore");
    out.push({ name: r.name, data });
  }
  return out;
}

/** ir_attachment.py:469-489 `_compute_mimetype` of `{name, raw}`: the name's type, else the content's (refused). */
function mimetypeOf(name: string): string {
  const t = guessType(name);
  if (!t || t === "application/octet-stream") throw new NotPorted(`mimetype of ${name} from its content (guess_mimetype)`);
  const m = t.toLowerCase();
  // :532-559 `_check_contents`: xml-like types and images (post-processing) are not ported here
  if (m.includes("ht") || (m.includes("xml") && !m.startsWith("application/vnd.openxmlformats")) || m.startsWith("image/")) throw new NotPorted(`attachment of type ${m} in the invoice mail`);
  return m;
}

/**
 * mail_thread.py:3129-3135 `_message_compute_author(email_from=...)`: `_partner_find_from_emails_single([email],
 * no_create=True)` (:2057-2170, res_partner.py:101-170): the active partners with the normalized email, the current
 * user's partner first (sort_key); several others refuse.
 */
async function authorFromEmail(env: Environment, emailFrom: string): Promise<number | false> {
  // res_partner.py:140 `parse_contact_from_email` (tools/mail.py:1111): the first address of the value
  const tuples = emailSplitTuples(emailFrom);
  if (tuples.length !== 1) throw new NotPorted("invoice mail author from several or no addresses");
  const norm = emailNormalize(tuples[0]![1]);
  if (!norm) throw new NotPorted("invoice mail author from an email that does not normalize");
  const rows = await env.model("res.partner").search(cond("email_normalized", "=", norm), { order: "id" });
  if (!rows.length) return false;
  if (rows.length === 1) return rows[0]!;
  const self = (await userInfo(env)).partnerId;
  if (rows.includes(self)) return self;
  throw new NotPorted("invoice mail author among several partners with the email (sort_key)");
}

/**
 * account_move.py:1034-1042 `_compute_type_name` of `move.with_context(lang=mail_lang)` (account_move_send.py:685):
 * `_('Invoice')` and `_('Credit Note')` in that language, the other types' selection labels (`_description_selection`).
 */
async function typeName(env: Environment, moveType: string, lang: string): Promise<string> {
  if (moveType === "out_invoice") return translateLang(lang, "Invoice", "account");
  if (moveType === "out_refund") return translateLang(lang, "Credit Note", "account");
  const r = (await env.cr.query<{ name: string }>(
    `SELECT COALESCE(s.name->>$2, s.name->>'en_US') AS name FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id
      WHERE f.model = 'account.move' AND f.name = 'move_type' AND s.value = $1`, [moveType, lang])).rows[0];
  if (!r) throw new NotPorted(`type_name of ${moveType}`);
  return r.name;
}

/**
 * `ir.attachment.create` (ir_attachment.py:921-956) as sudo of binary content with its mimetype known:
 * `_get_datas_related_values` (:424-441: checksum, size, index, the filestore name) and `_file_write` after the row.
 */
export async function createBinaryAttachment(env: Environment, a: { name: string; description: string | null; data: Uint8Array; mimetype: string; resModel: string; resId: number; resField: string | null; company: number }): Promise<number> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("attachment content outside a request");
  if ((await env.cr.query(`SELECT 1 FROM ir_config_parameter WHERE key = 'ir_attachment.location' AND value != 'file'`)).rows.length) throw new NotPorted("database attachment storage");
  const checksum = createHash("sha1").update(a.data).digest("hex");
  const storeFname = a.data.length ? `${checksum.slice(0, 2)}/${checksum}` : null; // ir_attachment.py:140 _file_fname
  const row = (await env.cr.query<{ id: number }>(
    `INSERT INTO ir_attachment (name, description, res_model, res_id, res_field, company_id, type, mimetype, file_size, checksum, store_fname,
       index_content, create_uid, write_uid, create_date, write_date)
     VALUES ($1, $2, $3, $4, $5, $6, 'binary', $7, $8, $9, $10, $11, $12, $12, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
    [a.name, a.description, a.resModel, a.resId, a.resField, a.company, a.mimetype, a.data.length, checksum, storeFname,
      a.data.length ? indexContent(a.data, a.mimetype) : null, env.uid])).rows[0]!;
  if (storeFname) await writeFile(ctx.env, ctx.db, storeFname, a.data);
  return row.id;
}

/** Checks of `_send_mails` that refuse before the transaction writes anything. */
export async function checkSendMail(env: Environment, s: SendSettings): Promise<void> {
  if (s.template === null) throw new NotPorted("invoice mail without a template");
  const t = (await env.cr.query<{ reply_to: string | null; mail_server_id: number | null }>("SELECT reply_to, mail_server_id FROM mail_template WHERE id = $1", [s.template])).rows[0];
  if (t?.reply_to) throw new NotPorted("invoice mail template with a reply-to");
  if (t?.mail_server_id) throw new NotPorted("invoice mail template with a mail server");
  if (s.widget.some((x) => x["dynamic_report"])) throw new NotPorted("dynamic reports of the invoice mail");
  const ubl = (await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'account.move' AND res_id = $1 AND res_field = 'ubl_cii_xml_file'", [s.move])).rows.length;
  if (ubl) throw new NotPorted("invoice mail with the UBL/CII file (_get_invoice_extra_attachments)");
  // the mail's attachments (:684-697) take `_get_invoice_extra_attachments` (a hook, src/models/account_move_send.ts):
  // a module's (l10n_it_edi: the FatturaPA file) refuses here
  if (await priv.account_move_send_wizard._get_invoice_extra_attachments.overridden(env)) throw new NotPorted("invoice mail with a module's _get_invoice_extra_attachments");
  // account_journal.py:1317-1345 `_notify_invoice_subscribers`
  const j = (await env.cr.query<{ e: string | null }>("SELECT incoming_einvoice_notification_email AS e FROM account_journal WHERE id = $1", [s.journal])).rows[0];
  if (j?.e) throw new NotPorted("invoice subscribers of the journal");
  const alias = (await env.cr.query("SELECT 1 FROM res_company WHERE id = ANY($1::int[]) AND alias_domain_id IS NOT NULL", [[s.company, await env.company()]])).rows.length;
  if (alias) throw new NotPorted("record alias domains (reply-to) of the invoice mail");
}

/**
 * `_hook_if_success` for the email method: `_send_mails` when the move's partner has an email or partners are chosen,
 * then `sending_data = False` (:887-892, a write even when already empty).
 */
export async function sendMails(env0: Environment, s: SendSettings): Promise<void> {
  const env = env0.sudo(); // moves_data keys are `move.sudo()` (:865-870)
  const partnerEmail = (await env.cr.query<{ email: string | null }>("SELECT email FROM res_partner WHERE id = $1", [s.partner])).rows[0]?.email;
  // `_is_applicable_to_move('email', move, **move_data)` (:392-396; a hook whose override needs Odoo's whole move_data,
  // which the hand port does not build: refused where one is installed), then :678-682
  if (await priv.account_move_send_wizard._is_applicable_to_move.overridden(env)) throw new NotPorted("_is_applicable_to_move of a module, with the send settings");
  if (s.partnerIds.length && (partnerEmail || s.partnerIds.length)) await sendMail(env0, s);
  await ormWrite(env, "account.move", [s.move], { sending_data: false });
}

async function sendMail(env0: Environment, s: SendSettings): Promise<void> {
  const ctx = requestOfCursor(env0.cr);
  if (ctx === null || ctx.db === null) throw new NotPorted("invoice mail outside a request");
  const lang = s.lang ?? "en_US";
  // :684-697 the PDF and widget attachments, the author from the template's email_from, the model description
  const attachments = await mailAttachments(env0, s);
  const emailFrom = await renderTemplateField(env0, s.template!, "email_from", s.move, lang);
  if (!emailFrom) throw new NotPorted("invoice mail without the template's email_from");
  const authorId = await authorFromEmail(env0, emailFrom);
  const modelDescription = await typeName(env0, s.moveType, lang);
  // :555-573 `_send_mail`: message_post on the sudo move with the notification context
  const env = env0.sudo().withContext({ ...env0.context, lang, email_notification_allow_footer: true, disable_attachment_import: true, no_document: true });
  const mm = env.reg.model("mail.message");
  const body = s.body ? await sanitizeHtml(env, mm, mm.fields.get("body")!, s.body) : "";
  const subtype = await xmlid(env, "mail.mt_comment");
  // :2512-2606 attachments created as sudo on the move (name, raw, type binary, description), before the message
  const attachmentIds: number[] = [];
  const company = await env.company();
  for (const a of attachments) {
    attachmentIds.push(await createBinaryAttachment(env, { name: a.name, description: a.name, data: a.data, mimetype: mimetypeOf(a.name), resModel: "account.move", resId: s.move, resField: null, company }));
  }
  const parentId = await flatThreadParent(env, "account.move", s.move);
  const [mid] = await insertMessages(env, [{
    model: "account.move", res_id: s.move, body, author_id: authorId, email_from: emailFrom, message_type: "comment", subtype_id: subtype,
    subject: s.subject || false, email_add_signature: false, record_alias_domain_id: false, record_company_id: s.company,
    // `_notify_get_reply_to(default=email_from)` without alias domains (checked)
    reply_to: emailFrom, message_id: trackingMessageId(`${s.move}-account.move`),
    email_layout_xmlid: "account_peppol.mail_notification_layout_with_responsible_signature_and_peppol", reply_to_force_new: false, mail_server_id: false,
    attachment_ids: attachmentIds, partner_ids: s.partnerIds, ...(parentId ? { parent_id: parentId } : {}),
  }]);
  // :2420-2431 the real author (the active current user) follows a comment of the Discussions subtype
  const user = await userInfo(env0);
  const share = (await env.cr.query<{ s: boolean | null }>("SELECT partner_share AS s FROM res_partner WHERE id = $1", [user.partnerId])).rows[0];
  if (user.active && !share?.s && !env.context["mail_post_autofollow_author_skip"]) await messageSubscribe(env, "account.move", [s.move], [user.partnerId], null);
  // mail_thread_main_attachment.py:17-47 `_message_post_after_hook` (account's :7997 returns to it with
  // disable_attachment_import): the pdf (else image, else first) attachment becomes the main one when there is none
  if (attachmentIds.length) {
    const current = (await env.cr.query<{ m: number | null }>("SELECT message_main_attachment_id AS m FROM account_move WHERE id = $1", [s.move])).rows[0]?.m ?? null;
    if (current === null) {
      const rows = (await env.cr.query<{ id: number; mimetype: string }>("SELECT id, mimetype FROM ir_attachment WHERE id = ANY($1::int[]) ORDER BY id", [attachmentIds])).rows
        .filter((r) => !r.mimetype.endsWith("xml") && !r.mimetype.endsWith("application/octet-stream") && r.mimetype !== "message/rfc822");
      // max() keeps the first of equal keys (message.attachment_ids in id order)
      let best: typeof rows[number] | null = null;
      const key = (r: typeof rows[number]): number => (r.mimetype.endsWith("pdf") ? 2 : 0) + (r.mimetype.startsWith("image") ? 1 : 0);
      for (const r of rows) if (best === null || key(r) > key(best)) best = r;
      if (best) await ormWrite(env, "account.move", [s.move], { message_main_attachment_id: best.id });
    }
  }
  // :2433 `_notify_thread(message, model_description, notify_author_mention, mail_auto_delete)`
  const auto = (await env.cr.query<{ a: boolean | null }>("SELECT auto_delete AS a FROM mail_template WHERE id = $1", [s.template])).rows[0]?.a;
  const notified = await notifyThread(ctx, env0.withContext({ ...env0.context, lang, email_notification_allow_footer: true, disable_attachment_import: true, no_document: true }),
    "account.move", s.move, mid!, { modelDescription, allowFooter: true, autoDelete: Boolean(auto) });
  // :575-582 the copies move onto the message (res_id cleared by SQL, then the ORM write)
  if (attachmentIds.length) {
    await env.cr.query("UPDATE ir_attachment SET res_id = NULL WHERE id = ANY($1::int[])", [attachmentIds]);
    await env.cr.query(`UPDATE ir_attachment SET res_model = 'mail.message', res_id = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])`, [attachmentIds, mid, env.uid]);
  }
  // send_after_commit: the refused SMTP connection is recorded once everything else is written
  await notified.send();
}
