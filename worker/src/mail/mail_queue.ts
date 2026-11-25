/**
 * The email queue (odoo/addons/mail/models/mail_mail.py:229-284 `process_email_queue`, run by the cron job "Mail: Email
 * Queue Manager"): the outgoing mails due, sent by `send()` (:752-812) in batches of one sending configuration
 * (`_split_by_mail_configuration` :586-636).
 *
 * D9: no ir.mail_server and no smtp_server in the server configuration, so `ir.mail_server._connect__` tries
 * localhost:25 and every batch fails to connect (`smtpConnectFailure`): its mails go to exception with the connection
 * error (:788-790) and `_postprocess_sent_message(success_pids=[], success_emails=[], failure_type="mail_smtp")`
 * (:286-325) marks their notifications as failed and tells the users on the bus (`_notify_message_notification_update`,
 * mail_message.py:1445-1473). `post_send_callback` is only called by `_send`, never on a refused connection, so the
 * cron's progress stays (0, 0).
 *
 * Refused before anything is written: a configured mail server (`_find_mail_server` picks one), a mail with its own
 * server, `mail.default.from_filter`, the `filters` context key, a run as a non-superuser user, a failure notification
 * to an author other than the cron user (its read access as that user), and a reachable SMTP server (D9: delivery is
 * not ported).
 */
import type { Env } from '../env';
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';
import { BusValues, dispatchRows } from '../bus/bus';
import { storeVersion } from '../bus/presence';
import { icpInt, icpStr } from '../session/user';
import { emailSplitTuples } from './thread_generic';
import { emailNormalize, formatAddr } from './message';
import { smtpConnectFailure } from './notify';
import { addNotificationMessage } from './menu';
import { Store } from './store';

interface QueuedMail {
  id: number; email_from: string | null; mail_server_id: number | null; record_alias_domain_id: number | null; is_notification: boolean | null;
}

/** tools/mail.py `email_split_and_format_normalize(email_from)[0]`, else the value itself (mail_mail.py:607-609). */
function sendingFrom(emailFrom: string | null): string | null {
  const [first] = emailSplitTuples(emailFrom);
  if (!first) return emailFrom;
  return formatAddr(first[0], emailNormalize(first[1]) ?? first[1]);
}

/** mail_mail.py:229-284 `process_email_queue(email_ids=(), batch_size)` from the cron (no email_ids). */
export async function processEmailQueue(env: Environment, worker: Env, batchSize: number): Promise<void> {
  if (!env.su) throw new NotPorted('the email queue run as a non-superuser user (mail.mail access rules)');
  if ('filters' in env.context) throw new NotPorted('process_email_queue with context filters');
  const size = (await icpInt(env.cr, 'mail.mail.queue.batch.size')) || batchSize;
  // :241-252 outgoing and due (`datetime.utcnow()`: the database clock here), `_order = 'id desc'`, then sorted
  const sendIds = (await env.cr.query<{ id: number }>(
    `SELECT id FROM mail_mail WHERE state = 'outgoing' AND (scheduled_date IS NULL OR scheduled_date <= (now() AT TIME ZONE 'UTC'))
      ORDER BY id DESC LIMIT $1`, [size])).rows.map((r) => r.id).sort((a, b) => a - b);
  if (!sendIds.length) return;
  await send(env, worker, sendIds);
}

/** mail_mail.py:752-812 `send()` where every connection is refused. */
export async function sendMails(env: Environment, worker: Env, ids: readonly number[]): Promise<void> {
  return send(env, worker, ids);
}

async function send(env: Environment, worker: Env, ids: readonly number[]): Promise<void> {
  const mails = (await env.cr.query<QueuedMail>(
    `SELECT mm.id, m.email_from, m.mail_server_id, m.record_alias_domain_id, mm.is_notification
       FROM mail_mail mm JOIN mail_message m ON m.id = mm.mail_message_id WHERE mm.id = ANY($1::int[])`, [[...ids]])).rows;
  const byId = new Map(mails.map((m) => [m.id, m]));
  // :601-602 all mail servers; _find_mail_server (ir_mail_server.py:848-922) returns one as soon as any is active
  if ((await env.cr.query('SELECT 1 FROM ir_mail_server WHERE active LIMIT 1')).rows.length) throw new NotPorted('sending through a configured ir.mail_server');
  if (mails.some((m) => m.mail_server_id !== null)) throw new NotPorted('a queued mail with its own mail server');
  // ir_mail_server.py:909-922 step 5: without servers the CLI configuration; a from_filter could change the sender
  if (await icpStr(env.cr, 'mail.default.from_filter')) throw new NotPorted('mail.default.from_filter (_match_from_filter)');
  // :604-630 grouped by (mail server, alias domain, sender) in the order of the mails; without a from_filter the
  // SMTP sender is the mail's own (step 5 `_match_from_filter` is True)
  const groups = new Map<string, number[]>();
  for (const id of ids) {
    const m = byId.get(id);
    if (!m) continue; // read() drops ids that vanished meanwhile
    const key = JSON.stringify([m.record_alias_domain_id, sendingFrom(m.email_from)]);
    groups.set(key, [...(groups.get(key) ?? []), id]);
  }
  const sessionBatch = (await icpInt(env.cr, 'mail.session.batch.size')) || 1000;
  // the transaction's written fields, and one bus Store per batch: Odoo serializes them at the end of the transaction
  // (bus precommit), so each carries every write of the run in its version
  const written: Record<string, Record<string, string[]>> = {};
  const stores: { uid: number; store: Store }[] = [];
  for (const groupIds of groups.values()) {
    for (let i = 0; i < groupIds.length; i += sessionBatch) {
      const batch = groupIds.slice(i, i + sessionBatch);
      // :781 `_connect__`: refused (D9); a reachable server refuses inside (delivery is not ported)
      const reason = await smtpConnectFailure();
      const messageIds = await failBatch(env, batch, byId, reason, written);
      if (messageIds.length) stores.push(...await notifyMessageNotificationUpdate(env, messageIds));
    }
  }
  if (!stores.length) return;
  const bus = new BusValues(env.cr.db);
  for (const { uid, store } of stores) {
    const data = await store.asDict(env.cr);
    if (data['__store_version__']) data['__store_version__'] = await storeVersion(env.cr, written);
    bus.sendone({ model: 'res.users', id: uid }, 'mail.record/insert', data);
  }
  const busRows = await bus.create(env.cr, env.uid);
  env.cr.postcommit.push(() => dispatchRows(worker, env.cr.db, busRows));
}

/**
 * :788-790 the batch's write, then `_postprocess_sent_message` with failure_type mail_smtp (:286-325). Returns the
 * thread messages of the failed notifications, for `_notify_message_notification_update`.
 */
async function failBatch(env: Environment, batch: readonly number[], byId: ReadonlyMap<number, QueuedMail>, reason: string,
  written: Record<string, Record<string, string[]>>): Promise<number[]> {
  await env.cr.query(
    `UPDATE mail_mail SET state = 'exception', failure_reason = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = ANY($1::int[])`,
    [[...batch], reason, env.uid]);
  written['mail.mail'] ??= {};
  for (const id of batch) {
    // the write's fields are all dirty: `_split_by_mail_configuration` read only the sending fields
    // (prefetch_fields=False), so no cached value equals the written one (fields.py `_filter_not_equal`)
    written['mail.mail']![String(id)] = ['state', 'failure_reason', 'write_uid', 'write_date'];
  }
  const notifMails = batch.filter((id) => byId.get(id)?.is_notification);
  if (!notifMails.length) return [];
  // the notifications (mail.notification has no _order: by id), all failed: no success_pids nor success_emails
  const notifications = (await env.cr.query<{ id: number; mail_message_id: number; status: string; failure_type: string | null; failure_reason: string | null }>(
    `SELECT id, mail_message_id, notification_status AS status, failure_type, failure_reason FROM mail_notification
      WHERE notification_type = 'email' AND mail_mail_id = ANY($1::int[]) AND notification_status NOT IN ('sent', 'canceled') ORDER BY id`,
    [notifMails])).rows;
  if (!notifications.length) return [];
  await env.cr.query(
    `UPDATE mail_notification SET notification_status = 'exception', failure_type = 'mail_smtp', failure_reason = NULL
      WHERE id = ANY($1::int[])`, [notifications.map((n) => n.id)]);
  written['mail.notification'] ??= {};
  for (const n of notifications) {
    // the fields whose value the write changed: `filtered(...)` on res_partner_id prefetched the notifications (no log access)
    const fields = [...(n.status !== 'exception' ? ['notification_status'] : []), ...(n.failure_type !== 'mail_smtp' ? ['failure_type'] : []),
      ...(n.failure_reason !== null ? ['failure_reason'] : [])];
    if (fields.length) written['mail.notification']![String(n.id)] = fields;
  }
  // `notifications.mapped('mail_message_id').filtered(_is_thread_message)`: first occurrence order
  return [...new Set(notifications.map((n) => n.mail_message_id))];
}

/**
 * mail_message.py:1445-1473 `_notify_message_notification_update` of the cron's (superuser) environment: the messages
 * whose document exists, to the current user (the cron user's partner) and to each author, one Store per user with
 * `_store_notification_fields` (the Stores returned, sent by the caller at the end of the transaction).
 */
async function notifyMessageNotificationUpdate(env: Environment, messageIds: readonly number[]): Promise<{ uid: number; store: Store }[]> {
  const rows = (await env.cr.query<{ id: number; model: string | null; res_id: number | null; author_id: number | null }>(
    'SELECT id, model, res_id, author_id FROM mail_message WHERE id = ANY($1::int[])', [[...messageIds]])).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const messages: { id: number; model: string; resId: number; author: number | null }[] = [];
  for (const id of messageIds) {
    const m = byId.get(id);
    // `_is_thread_message`, then `_record_by_message` and the record's existence (MissingError: skipped)
    if (!m || !m.model || m.model === 'mail.thread' || !m.res_id) continue;
    const table = env.reg.model(m.model).table;
    if (!(await env.cr.query(`SELECT 1 FROM "${table}" WHERE id = $1`, [m.res_id])).rows.length) continue;
    messages.push({ id, model: m.model, resId: m.res_id, author: m.author_id });
  }
  if (!messages.length) return [];
  const selfRow = (await env.cr.query<{ partner_id: number; share: boolean | null }>('SELECT partner_id, share FROM res_users WHERE id = $1', [env.uid])).rows[0]!;
  if (selfRow.share) throw new NotPorted('failure notifications sent by a share user');
  const self = selfRow.partner_id;
  // :1463-1468 messages per partner: the current user (not public) gets all, each author without a public user its
  // own; then the partner's `main_user_id` (res_partner.py:517-531: the current user for its own partner, else the
  // active users internal first and by id, OdooBot's archived root user for partner_root)
  const perPartner = new Map<number, number[]>([[self, []]]);
  for (const m of messages) {
    perPartner.get(self)!.push(m.id);
    if (m.author === null) continue;
    if ((await env.cr.query(
      `SELECT 1 FROM res_users u JOIN res_groups_users_rel r ON r.uid = u.id JOIN ir_model_data d ON d.model = 'res.groups' AND d.res_id = r.gid
        WHERE u.partner_id = $1 AND d.module = 'base' AND d.name = 'group_public' LIMIT 1`, [m.author])).rows.length) continue;
    if (!perPartner.has(m.author)) perPartner.set(m.author, []);
    if (m.author !== self) perPartner.get(m.author)!.push(m.id);
  }
  const stores: { uid: number; store: Store }[] = [];
  for (const [partner, ids] of perPartner) {
    let uid: number | null = partner === self ? env.uid : null;
    let share = false;
    if (uid === null) {
      const u = (await env.cr.query<{ id: number; share: boolean | null }>(
        'SELECT id, share FROM res_users WHERE partner_id = $1 AND active ORDER BY share IS TRUE, id LIMIT 1', [partner])).rows[0];
      if (u) { uid = u.id; share = Boolean(u.share); }
      else if (partner === (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = 'base' AND name = 'partner_root'")).rows[0]?.id) uid = 1;
    }
    if (uid === null) continue;
    // `messages.with_user(user)._filtered_access('read')`: an internal author reads its own messages (author_id rule,
    // mail_message.py:568-702); the superuser reads everything (environments.py:66)
    if (share) throw new NotPorted('failure notification to a portal author (share users\' message access)');
    const store = new Store();
    for (const id of ids) {
      const m = messages.find((x) => x.id === id)!;
      await addNotificationMessage(env, store, id, m.model, m.resId);
    }
    stores.push({ uid, store });
  }
  return stores;
}
