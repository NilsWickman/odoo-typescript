/**
 * `message_post_with_source(source_ref, *, render_values, message_type, subtype_xmlid, subtype_id, **kwargs)`
 * (mail/models/mail_thread.py:2724-2812) with a mail.template: a composer in comment mode on the records
 * (`default_composition_mode` 'comment', `default_model`, `default_res_ids`, `default_template_id`) created with the
 * message type, the subtype and the kwargs, then `_action_send_mail` (src/mail/composer.ts). Returns the messages.
 * The source is an xmlid (`_get_source_from_ref` :3296-3350) or, from compiled code, the template record (its ids,
 * compiler/runtime/records.ts `toJs`). A view source, render values and several records refuse.
 */
import { NotPorted } from '../errors';
import { registerMethod } from '../http/methods';
import { create } from '../orm/create';
import type { Environment } from '../orm/types';
import { envFor } from '../web/common';
import { sendComposerComment } from './composer';
import { xmlid } from './message';
import { idsModel } from '../orm/private_hooks';

/** :3296-3350 `_get_source_from_ref`: the template id, or a refusal (views, other models). */
async function templateOfRef(env: Environment, ref: unknown): Promise<number> {
  if (typeof ref === 'string') {
    const m = /^([\w.-]+)\.([\w.-]+)$/.exec(ref);
    const row = m ? (await env.cr.query<{ model: string; res_id: number }>('SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2', [m[1], m[2]])).rows[0] : undefined;
    if (!row) throw new NotPorted(`message_post_with_source of a missing xmlid ${ref} (ValueError)`);
    if (row.model === 'ir.ui.view') throw new NotPorted('message_post_with_source of a view (_render_template_qweb_view)');
    if (row.model !== 'mail.template') throw new NotPorted(`message_post_with_source of a ${row.model} (ValueError)`);
    return row.res_id;
  }
  // the template record passed by compiled code (its ids)
  if (Array.isArray(ref) && ref.length === 1 && typeof ref[0] === 'number') return ref[0];
  throw new NotPorted(`message_post_with_source source ${JSON.stringify(ref)}`);
}

/** :2766-2773 `_raise_for_invalid_parameters` forbidden names. */
const FORBIDDEN = new Set(['body', 'composition_mode', 'incoming_email_cc', 'incoming_email_to', 'model', 'res_id', 'outgoing_email_to', 'values']);
/** The composer fields a kwarg may set here (the others refuse). */
const COMPOSER_KWARGS = new Set(['email_layout_xmlid', 'email_add_signature', 'subject', 'auto_delete', 'mail_server_id', 'reply_to']);

export async function messagePostWithSource(env: Environment, model: string, ids: readonly number[], ref: unknown, kwargs: Record<string, unknown>): Promise<number[]> {
  const def = env.reg.model(model);
  if (!def.isMailThread) throw new NotPorted(`message_post_with_source on ${model} (not a mail.thread)`);
  if (ref === 'mail.message_origin_link') return originLink(env, model, ids, kwargs);
  const template = await templateOfRef(env, ref);
  const { render_values: renderValues, message_type: messageType0, subtype_xmlid: subtypeXmlid, subtype_id: subtypeId0, ...rest } = kwargs;
  if (renderValues !== undefined && renderValues !== null && (typeof renderValues !== 'object' || Object.keys(renderValues).length)) {
    throw new NotPorted('message_post_with_source with render_values');
  }
  for (const k of Object.keys(rest)) {
    if (FORBIDDEN.has(k)) throw new NotPorted(`message_post_with_source with ${k} (ValueError)`);
    if (!COMPOSER_KWARGS.has(k)) throw new NotPorted(`message_post_with_source with ${k}`);
  }
  const messageType = messageType0 === undefined ? 'notification' : messageType0;
  // :2785-2789
  let subtypeId = typeof subtypeXmlid === 'string' && subtypeXmlid ? await xmlid(env, subtypeXmlid) : subtypeId0;
  if (!subtypeId) subtypeId = await xmlid(env, 'mail.mt_note');
  if (!ids.length) return [];
  if (ids.length !== 1) throw new NotPorted('message_post_with_source of a template on several records (batch composer)');
  // :2794-2804 the composer, then `_action_send_mail`
  const cenv = env.withContext({ ...env.context, default_composition_mode: 'comment', default_model: model, default_res_ids: [...ids], default_template_id: template });
  const [composer] = await create(cenv, 'mail.compose.message', [{ message_type: messageType, subtype_id: subtypeId, ...rest }]);
  return [await sendComposerComment(cenv, composer!)];
}

registerMethod('*', 'message_post_with_source', async (env0, ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (args.length !== 1) throw new NotPorted('message_post_with_source with other than one positional argument (TypeError)');
  return messagePostWithSource(env, model, ids ?? [], args[0], kwargs);
}, { apiModel: false });

/**
 * `message_post_with_source('mail.message_origin_link', render_values={'self': record, 'origin': records},
 * subtype_xmlid='mail.mt_note')` (mail_templates_chatter.xml:52-60, rendered by `_render_template_qweb_view`), from
 * compiled code (purchase_requisition's purchase.order create): the "created from" note with a link per origin
 * record, posted on each record as src/models/stock_engine.ts postOriginLink does. The origin's model comes beside its
 * ids (src/orm/private_hooks.ts idsModel). `edit` (the "modified from" text), another `self` and other keyword
 * arguments refuse.
 */
async function originLink(env: Environment, model: string, ids: readonly number[], kwargs: Record<string, unknown>): Promise<number[]> {
  const { render_values: rv, subtype_xmlid: subtype, ...rest } = kwargs;
  if (Object.keys(rest).length) throw new NotPorted(`message_post_with_source of mail.message_origin_link with ${Object.keys(rest).join(', ')}`);
  if (subtype !== 'mail.mt_note') throw new NotPorted('message_post_with_source of mail.message_origin_link with another subtype');
  if (!rv || typeof rv !== 'object' || Array.isArray(rv)) throw new NotPorted('message_post_with_source of mail.message_origin_link without render values');
  const { self: selfIds, origin, edit, ...more } = rv as Record<string, unknown>;
  if (Object.keys(more).length) throw new NotPorted(`mail.message_origin_link render values ${Object.keys(more).join(', ')}`);
  if (edit) throw new NotPorted('mail.message_origin_link with edit (the "modified from" text)');
  if (ids.length !== 1) throw new NotPorted('message_post_with_source of mail.message_origin_link on several records');
  if (!Array.isArray(selfIds) || selfIds.length !== 1 || selfIds[0] !== ids[0] || (idsModel(selfIds) ?? model) !== model) {
    throw new NotPorted('mail.message_origin_link of another record than the one posted on');
  }
  const originModel = idsModel(origin);
  if (!Array.isArray(origin) || originModel === null) throw new NotPorted('mail.message_origin_link of an origin without its model');
  if (origin.length !== 1) throw new NotPorted('mail.message_origin_link of several or no origin records');
  const { postOriginLink } = await import('../models/stock_engine');
  await postOriginLink(env, model, [ids[0]!], { model: originModel, id: Number(origin[0]) });
  const last = (await env.cr.query<{ id: number }>('SELECT max(id) AS id FROM mail_message WHERE model = $1 AND res_id = $2', [model, ids[0]])).rows[0]!.id;
  return [last];
}
