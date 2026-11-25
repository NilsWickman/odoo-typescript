/**
 * Store notifications on the bus (odoo/addons/mail/tools/discuss.py Store(bus_channel=...) -> bus.listener.mixin
 * `_bus_send`, bus/models/bus.py `_sendone`): the `bus_bus` row is inserted in the request transaction (Odoo's
 * precommit `create_bus`) and handed to the BusDispatcher once the transaction committed (`ctx.afterCommit`).
 */
import { parseDomain } from '../orm/domain';
import { requestOfCursor, type RequestContext } from '../http/context';
import { registerMethod } from '../http/methods';
import { envFor } from '../web/common';
import { NotPorted, OdooError } from '../errors';
import { userInfo } from '../orm/env';
import { Cursor } from '../db';
import type { Environment } from '../orm/types';
import { BusValues, dispatchRows, type RecordTarget } from '../bus/bus';
import type { WrittenFields } from '../bus/presence';
import { recordWritten } from '../orm/written_fields';

/** A Store payload whose `__store_version__` is formatted when the row is created (discuss.py:81-107). */
export type VersionedPayload = (written: WrittenFields) => Promise<unknown>;

const DEFERRED = new WeakMap<Cursor, { target: RecordTarget; type: string; payload: unknown; versioned: VersionedPayload | null }[]>();

export async function busSend(ctx: RequestContext, env: Environment, target: RecordTarget, type: string, payload: unknown,
  when: 'commit' | 'response' = 'commit', versioned: VersionedPayload | null = null): Promise<void> {
  const db = ctx.db;
  if (db === null) return;
  const queue = when === 'commit' ? DEFERRED.get(env.cr) : undefined;
  if (queue) { queue.push({ target, type, payload, versioned }); return; }
  const bus = new BusValues(db);
  bus.sendone(target, type, versioned ? await versioned({}) : payload);
  if (when === 'response') {
    // Notifications Odoo sends from a later transaction (the post-commit mail send, mail_mail.py:745-750): the row is
    // created in its own transaction once the HTTP answer is out, so its id follows everything already delivered and
    // the client receives it after the answer (which would otherwise overwrite it in the client store).
    const uid = env.uid;
    ctx.afterResponse(async () => {
      await new Promise(r => setTimeout(r, 100));
      const cr = new Cursor(ctx.env, db);
      let rows;
      try {
        rows = await bus.create(cr, uid);
        await cr.commit();
      } finally {
        await cr.close();
      }
      await dispatchRows(ctx.env, db, rows);
    });
    return;
  }
  const rows = await bus.create(env.cr, env.uid);
  ctx.afterCommit(() => dispatchRows(ctx.env, db, rows));
}

/**
 * Runs `fn` with its bus notifications held, as Odoo's precommit holds them (bus.py:92-137 `_sendone` collects, the
 * Store's version is formatted once, at the first precommit formatting, `get_formatted_version`): the rows are created
 * afterwards in the order sent, and the Store payloads (`versioned`) get the fields `fn`'s ORM writes flushed
 * (src/orm/written_fields.ts, whose window refuses a direct UPDATE it cannot account for).
 */
export async function withStoreVersionAtEnd<T>(ctx: RequestContext, env: Environment, fn: () => Promise<T>): Promise<T> {
  if (DEFERRED.has(env.cr)) throw new NotPorted('nested held bus notifications');
  const queue: { target: RecordTarget; type: string; payload: unknown; versioned: VersionedPayload | null }[] = [];
  DEFERRED.set(env.cr, queue);
  let res: { out: T; written: WrittenFields };
  try {
    res = await recordWritten(env, fn, true);
  } finally {
    DEFERRED.delete(env.cr);
  }
  for (const s of queue) await busSend(ctx, env, s.target, s.type, s.versioned ? await s.versioned(res.written) : s.payload);
  return res.out;
}

/**
 * `mail.message.set_message_done` (mail_message.py:947), run by `/mail/thread/messages` after resolving the
 * messages (webclient.py:168-169): the user's unread notifications of them become read (mail_notification.py:85-89
 * sets read_date), and `mail.message/mark_as_read` goes to the user.
 */
export async function setMessageDone(ctx: RequestContext, env: Environment, messageIds: readonly number[], partnerId: number): Promise<number[]> {
  if (!messageIds.length) return [];
  const rows = (await env.cr.query<{ id: number; mail_message_id: number }>(
    'SELECT id, mail_message_id FROM mail_notification WHERE mail_message_id = ANY($1::int[]) AND res_partner_id = $2 AND is_read IS NOT TRUE ORDER BY id',
    [messageIds, partnerId])).rows;
  if (!rows.length) return [];
  await env.cr.query(`UPDATE mail_notification SET is_read = true, read_date = date_trunc('second', now() AT TIME ZONE 'UTC') WHERE id = ANY($1::int[])`, [rows.map(r => r.id)]);
  const count = (await env.cr.query<{ n: string }>('SELECT count(*)::text AS n FROM mail_notification WHERE res_partner_id = $1 AND (is_read = false OR is_read IS NULL)', [partnerId])).rows[0]!;
  // `notifications.mail_message_id.ids`: the messages of the notifications in their (id desc) order, deduplicated
  const mids = [...new Set(rows.map(r => r.mail_message_id))];
  await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.message/mark_as_read', { message_ids: mids, needaction_inbox_counter: Number(count.n) });
  return rows.map(r => r.id);
}

/** mail_message.py:947-965 `set_message_done` called by the client (message_model.js:868): returns None. */
registerMethod('mail.message', 'set_message_done', async (env0, ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  if (args.length || Object.keys(kwargs).length) throw new NotPorted('set_message_done with arguments');
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('set_message_done outside a request');
  await setMessageDone(ctx, env, ids ?? [], (await userInfo(env)).partnerId);
  return null;
}, { apiModel: false });

/**
 * mail_message.py:923-945 `mark_all_as_read(domain=None)` without a domain: every unread notification of the user's
 * partner becomes read (`search_fetch` in mail.notification's order, id) and `mail.message/mark_as_read` lists their
 * messages. With a domain: the messages found and their `set_message_done`.
 */
registerMethod('mail.message', 'mark_all_as_read', async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  for (const k of Object.keys(kwargs)) if (k !== 'domain') throw new OdooError('builtins.TypeError', `MailMessage.mark_all_as_read() got an unexpected keyword argument '${k}'`);
  const domain = 'domain' in kwargs ? kwargs['domain'] : args[0];
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('mark_all_as_read outside a request');
  const partnerId = (await userInfo(env)).partnerId;
  if (Array.isArray(domain) ? domain.length : domain) {
    // :930-933 `self.search(domain)` (no limit: mail.message's plain `_search` with its access rule) then
    // `set_message_done` of those messages
    const ids = await env.model('mail.message').search(parseDomain(domain));
    await setMessageDone(ctx, env, ids, partnerId);
    return ids;
  }
  const rows = (await env.cr.query<{ id: number; mail_message_id: number }>(
    'SELECT id, mail_message_id FROM mail_notification WHERE res_partner_id = $1 AND is_read IS NOT TRUE ORDER BY id', [partnerId])).rows;
  if (rows.length) {
    await env.cr.query(`UPDATE mail_notification SET is_read = true, read_date = date_trunc('second', now() AT TIME ZONE 'UTC') WHERE id = ANY($1::int[])`, [rows.map((r) => r.id)]);
  }
  const mids = [...new Set(rows.map((r) => r.mail_message_id))];
  const count = (await env.cr.query<{ n: string }>('SELECT count(*)::text AS n FROM mail_notification WHERE res_partner_id = $1 AND (is_read = false OR is_read IS NULL)', [partnerId])).rows[0]!;
  await busSend(ctx, env, { model: 'res.users', id: env.uid }, 'mail.message/mark_as_read', { message_ids: mids, needaction_inbox_counter: Number(count.n) });
  return mids;
}, { apiModel: true });
