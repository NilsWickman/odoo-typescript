/**
 * `_notify_thread` (odoo/addons/mail/models/mail_thread.py:3470) of a posted message on a document: recipients
 * (`_notify_get_recipients` :4279, mail_followers.py:91 `_get_recipient_data`), then by email
 * (`_notify_thread_by_email` :3594): one mail.mail per recipients group and language (`_notify_get_recipients_groups`
 * :4411: internal users with the access button, customers without; portal and non-user followers are inactive
 * groups and get nothing), its mail.notification rows, and `send_after_commit` (mail_mail.py:735-750) of the mails.
 *
 * Sending (D9: no ir.mail_server and no smtp_server in the server configuration): `ir.mail_server._connect__` tries
 * localhost:25; the refused connection is recorded as `send()` records it (mail_mail.py:784-790: mail state
 * exception with `exception_to_unicode(ConnectionRefusedError(111, 'Connection refused'))`, notifications exception
 * with failure_type mail_smtp, superuser write) and the failure goes to the author on the bus
 * (`_notify_message_notification_update`). The SMTP probe and that update follow stream CRM's
 * src/models/crm_lead_notify.ts (now importing them from here).
 *
 * Inbox recipients (`_notify_thread_by_inbox` :3528-3592): their mail.notification rows first, and the message's Store
 * to each user's bus (`NotifyResult.inbox`, sent by the callers that pass `inbox`, at the end of their request as at
 * Odoo's precommit; other callers refuse them).
 *
 * Refused: languages other than en_US, record alias domains, recipients without email, duplicate emails, previews
 * over 190 characters, out-of-office answers, web push devices of inbox recipients.
 */
import { inX2manyCacheOrder } from '../orm/x2many_order';
import { NotPorted } from '../errors';
import { cond } from '../orm/domain';
import type { RequestContext } from '../http/context';
import { requestOfCursor } from '../http/context';
import type { Environment } from '../orm/types';
import { userInfo } from '../orm/env';
import { databaseSecret, pyRepr, pyStrRepr, textwrapShorten, translateLang } from '../models/util';
import { viewTerms } from './view_terms';
import { createHmac } from 'node:crypto';
import { messagePreview } from '../models/mail_notify_layout';
import { emailLayout, lightLayout } from './notify_layout';
import { emailNormalize, formatAddr } from './message';
import { busSend } from './busnotify';
import { addNotificationMessage } from './menu';
import { Store } from './store';
import { storeVersion } from '../bus/presence';
import type { WrittenFields } from '../bus/presence';
import { chatterRefusal, isCompiledThread } from './thread_generic';
import { inDeferredFlush, noteRawWrite } from '../orm/recompute';
import { isHtmlEmpty } from '../qweb/helpers';

interface Recipient {
  id: number; name: string | null; email: string | null; emailNormalized: string | null; active: boolean; share: boolean;
  lang: string | null; uid: number | null; ushare: boolean; notif: 'inbox' | 'email'; type: 'user' | 'portal' | 'customer';
  isFollower: boolean; isCc: boolean;
}

/** mail_followers.py:91 `_get_recipient_data` + mail_thread.py:4329-4372 (author, inactive and emailed filtered). */
async function recipientsOf(env: Environment, model: string, resId: number, messageId: number, subtypeId: number, skipFollowers: boolean, authorMention = false): Promise<Recipient[]> {
  // mail_thread.py:4331 `(partner_ids | partner_cc_ids).ids`, :4366-4374 `is_cc` for the Cc partners
  const rels = (await env.cr.query<{ id: number; cc: boolean }>(
    `SELECT res_partner_id AS id, false AS cc FROM mail_message_res_partner_rel WHERE mail_message_id = $1
     UNION ALL SELECT res_partner_id AS id, true AS cc FROM mail_message_res_partner_cc_rel WHERE mail_message_id = $1`, [messageId])).rows;
  const pids = rels.map(r => r.id);
  const ccIds = new Set(rels.filter(r => r.cc).map(r => r.id));
  const followers = skipFollowers ? [] : (await env.cr.query<{ id: number }>(
    `SELECT f.partner_id AS id FROM mail_followers f JOIN mail_followers_mail_message_subtype_rel r ON r.mail_followers_id = f.id
       JOIN mail_message_subtype s ON s.id = r.mail_message_subtype_id JOIN res_partner p ON p.id = f.partner_id
      WHERE f.res_model = $1 AND f.res_id = $2 AND s.id = $3 AND (s.internal IS NOT TRUE OR p.partner_share IS NOT TRUE)`,
    [model, resId, subtypeId])).rows.map(r => r.id);
  // message_type user_notification (message_notify) relies on partner_ids only (mail_thread.py:4332-4335)
  const allFollowers = new Set((await env.cr.query<{ id: number }>('SELECT partner_id AS id FROM mail_followers WHERE res_model = $1 AND res_id = $2', [model, resId])).rows.map(r => r.id));
  const ids = [...new Set([...followers, ...pids])].sort((a, b) => a - b);
  if (!ids.length) return [];
  const rows = (await env.cr.query<{ id: number; name: string | null; email: string | null; active: boolean | null; share: boolean | null; lang: string | null }>(
    'SELECT id, name, email, active, partner_share AS share, lang FROM res_partner WHERE id = ANY($1::int[]) ORDER BY id', [ids])).rows;
  // :3159-3171 `_message_compute_real_author`: the current user when active, else (OdooBot, whose user is always
  // inactive: a cron job's or a server action's root) the message's author when active and not partner_root
  let realAuthor: number | null = (await userInfo(env)).partnerId;
  if (!(await env.cr.query<{ active: boolean | null }>('SELECT active FROM res_users WHERE id = $1', [env.uid])).rows[0]?.active) {
    const author = (await env.cr.query<{ id: number | null; active: boolean | null; root: boolean }>(
      `SELECT p.id, p.active, EXISTS (SELECT 1 FROM ir_model_data d WHERE d.module = 'base' AND d.name = 'partner_root' AND d.model = 'res.partner' AND d.res_id = p.id) AS root
         FROM mail_message m JOIN res_partner p ON p.id = m.author_id WHERE m.id = $1`, [messageId])).rows[0];
    realAuthor = author && author.active && !author.root ? author.id : null;
  }
  // :4351-4358 `notify_author_mention`: the author is notified when among the message's own partners
  const skipAuthor = realAuthor === null || (authorMention && pids.includes(realAuthor)) ? null : realAuthor;
  const out: Recipient[] = [];
  for (const p of rows) {
    if (p.id === skipAuthor || !p.active) continue;
    // users of the partner: internal first, then by id (mail_followers.py `_get_recipient_data` query)
    const user = (await env.cr.query<{ id: number; share: boolean | null; notification_type: string | null }>(
      'SELECT id, share, notification_type FROM res_users WHERE partner_id = $1 AND active ORDER BY share, id LIMIT 1', [p.id])).rows[0];
    const ushare = user ? Boolean(user.share) : false;
    out.push({
      id: p.id, name: p.name, email: p.email, emailNormalized: emailNormalize(p.email), active: true, share: Boolean(p.share), lang: p.lang,
      uid: user?.id ?? null, ushare, notif: user && !ushare && user.notification_type === 'inbox' ? 'inbox' : 'email',
      type: user ? (ushare ? 'portal' : 'user') : 'customer', isFollower: allFollowers.has(p.id), isCc: ccIds.has(p.id),
    });
  }
  return out;
}

type SocketsConnect = typeof import('cloudflare:sockets')['connect'];
let socketsConnect: SocketsConnect | null = null;

/**
 * The Worker's `connect`, given once when the isolate starts (src/index.ts imports `cloudflare:sockets` statically).
 * It was imported here at the first mail of an isolate, and Cloudflare refuses a dynamic import in an isolate that
 * is over its memory limit: the request then failed with "Dynamic import exceeded memory limits" (11 answers in
 * the site maps of 2026-11-12 and 13, each a save or a send that mails: G236's stage change was not made, and the
 * systray's counter stayed one off for the rest of the menu). This takes the import away, not the memory: an
 * isolate over the limit is still over it (docs/infra-2026-11-13.md section 11).
 */
export function provideSocketsConnect(connect: SocketsConnect): void {
  socketsConnect = connect;
}

/** `ir.mail_server._connect__()` to the configured default (localhost:25); the refused case only. */
export async function smtpConnectFailure(): Promise<string> {
  // not a static import here: the pure modules importing this file stay usable under node's test runner. Where
  // nothing provided it (a context that is not the Worker's entry), the module is still loaded at first use.
  const connect = socketsConnect ?? (await import('cloudflare:sockets')).connect;
  let socket: ReturnType<typeof connect> | null = null;
  try {
    socket = connect({ hostname: 'localhost', port: 25 });
    await socket.opened;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // tools.exception_to_unicode(ConnectionRefusedError): its args (errno, strerror) joined by newlines;
    // workerd reports a refused TCP connect as "proxy request failed, cannot connect to the specified address"
    // Deployed, Cloudflare refuses outbound port 25 before connecting ("Connections to port 25 are prohibited",
    // measured 2026-11-06 on S3): there is no mail server at localhost:25 either way, which Odoo reports as refused.
    if (/refused|ECONNREFUSED|cannot connect to the specified address|port 25 are prohibited/i.test(msg)) return '111\nConnection refused';
    throw new NotPorted(`SMTP connection outcome ${JSON.stringify(msg)} (mail delivery is not ported)`);
  }
  await socket.close();
  throw new NotPorted('SMTP delivery to a reachable mail server (mail_mail.py _send)');
}

/** mail_thread.py:4029-4051: up to 3 ancestors (public discussions first), oldest first, then the message. */
export async function mailReferences(env: Environment, model: string, resId: number, messageId: number): Promise<string> {
  const ancestors = (await env.cr.query<{ id: number; message_id: string; is_internal: boolean | null; sub_internal: boolean | null; message_type: string }>(
    `SELECT m.id, m.message_id, m.is_internal, s.internal AS sub_internal, m.message_type FROM mail_message m
       LEFT JOIN mail_message_subtype s ON s.id = m.subtype_id
      WHERE m.model = $1 AND m.res_id = $2 AND m.id != $3 AND m.subtype_id IS NOT NULL AND m.message_id IS NOT NULL
      ORDER BY m.id DESC LIMIT 32`, [model, resId, messageId])).rows;
  const key = (a: typeof ancestors[number]): number[] => [
    !a.is_internal && !a.sub_internal ? 1 : 0,
    ['comment', 'auto_comment', 'email', 'email_outgoing'].includes(a.message_type) ? 1 : 0,
    !['user_notification', 'out_of_office'].includes(a.message_type) ? 1 : 0,
  ];
  const best = ancestors.map((a, i) => ({ a, i })).sort((x, y) => {
    const kx = key(x.a), ky = key(y.a);
    for (let j = 0; j < 3; j++) if (kx[j] !== ky[j]) return ky[j]! - kx[j]!;
    return x.i - y.i; // sorted(reverse=True) is stable on the id DESC order
  }).slice(0, 3).map(x => x.a).sort((x, y) => x.id - y.id);
  const own = (await env.cr.query<{ message_id: string }>('SELECT message_id FROM mail_message WHERE id = $1', [messageId])).rows[0]!.message_id;
  return [...best.map(a => a.message_id), own].join(' ');
}

/** Python `repr()` of a dict of str values (headers, :4088), stripping CR/LF to prevent SMTP header injection. */
export function reprStrDict(d: ReadonlyArray<[string, string]>): string {
  const clean = (s: string): string => pyStrRepr(s.replace(/[\r\n]+/g, ' '));
  return `{${d.map(([k, v]) => `${clean(k)}: ${clean(v)}`).join(', ')}}`;
}

/** Splice the responsible signature into the rendered layout without interpreting `$&` / `$$` replacement tokens. */
export function spliceResponsibleSignature(body: string, msgBody: string, responsibleSignature: string): string {
  const marker = `<div style="font-size: 13px;">${msgBody}</div>\n\n                \n            `;
  const replacement = `<div style="font-size: 13px;">${msgBody}</div>\n\n                    <div class="o_signature" style="font-size: 13px;">${responsibleSignature}</div>\n                \n            `;
  // the marker missing would drop the signature silently
  if (!body.includes(marker)) throw new NotPorted('responsible signature: the layout around the message body differs');
  return body.replace(marker, () => replacement);
}

/** mail_mail.py:320-322 `_notify_message_notification_update` (mail_message.py:1445-1473): the failure to the users. */
export async function notifyFailure(env: Environment, messageId: number, written: Record<string, Record<string, string[]>> = {}): Promise<void> {
  const msg = (await env.cr.query<{ model: string | null; res_id: number | null; author_id: number | null }>(
    'SELECT model, res_id, author_id FROM mail_message WHERE id = $1', [messageId])).rows[0];
  if (!msg || !msg.model || msg.model === 'mail.thread' || !msg.res_id) return; // _is_thread_message
  // the send runs as superuser (mail_mail.py:745-750): env.user is the root user, whose partner is OdooBot
  const rootPartner = (await env.cr.query<{ partner_id: number }>('SELECT partner_id FROM res_users WHERE id = 1')).rows[0]!.partner_id;
  const targets: number[] = [1]; // :1465-1466 then the author (:1467-1468); partner.main_user_id of OdooBot is the root user
  if (msg.author_id !== null && msg.author_id !== rootPartner) {
    const user = (await env.cr.query<{ id: number }>('SELECT id FROM res_users WHERE partner_id = $1 AND active ORDER BY share, id LIMIT 1', [msg.author_id])).rows[0];
    if (user) targets.push(user.id);
  }
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted('failure notification outside a request');
  for (const uid of targets) {
    // :1472 `messages.with_user(user)._filtered_access('read')`: the targets are the root user and the author's user,
    // and the author reads their own message whatever the document's access (mail_message.py:651-658 `author_id ==
    // pid`), so nobody is filtered out
    const user = { id: uid };
    const store = new Store();
    await addNotificationMessage(uid === env.uid ? env : env.withUser(uid), store, messageId, msg.model, msg.res_id);
    const data = await store.asDict(env.cr);
    // the sending transaction's written fields (mail_mail.py:784-790 writes) in the Store version
    if (data['__store_version__']) data['__store_version__'] = await storeVersion(env.cr, written);
    await busSend(ctx, env, { model: 'res.users', id: user.id }, 'mail.record/insert', data, 'response');
  }
}

export interface NotifyResult {
  /** Fields written on the message (mail.mail `subject` through `_inherits`), for the Store version. */
  readonly messageWritten: readonly string[];
  /** Fields the ORM wrote on other records while the groups were built (the portal token, `signup_prepare`), as
   * mail's `Base._flush` marks them (mail/models/models.py:29-34) for the Store version. */
  readonly recordsWritten: WrittenFields;
  /** `send_after_commit`: run once the response is serialized (the response shows the notifications ready). */
  send(): Promise<void>;
  /** mail_thread.py:3577-3587: the message's Store to the bus of each inbox user, serialized at Odoo's precommit, so
   *  the caller runs it at the end of its request with the fields the transaction wrote (`written`, its version). */
  inbox(written: WrittenFields): Promise<void>;
}

export interface NotifyOptions {
  /** `email_notification_force_header` / `_force_footer` context keys (mail_activity.py:611-614). */
  readonly forceHeader?: boolean;
  readonly forceFooter?: boolean;
  /** `subtitles` / `model_description` kwargs of message_notify (they replace the model's own, mail_thread.py:3852-3853). */
  readonly subtitles?: readonly string[];
  /** The record name the layout's first subtitle shows instead of the current one (a cached display_name). */
  readonly layoutRecordName?: string;
  readonly modelDescription?: string;
  /** `email_layout_xmlid='mail.mail_notification_light'`. */
  readonly light?: boolean;
  /** The caller sends the inbox Stores (`NotifyResult.inbox`); without it inbox recipients refuse. */
  readonly inbox?: boolean;
  /** `email_notification_allow_footer` context key (account_move_send.py:558-561): the footer of groups with a header. */
  readonly allowFooter?: boolean;
  /** `notify_author_mention` (message_notify's default True, mail_thread.py:2901): the author among the message's
   *  partners is notified. */
  readonly notifyAuthorMention?: boolean;
  /** `mail_auto_delete` kwarg of `_notify_thread_by_email` (default True). */
  readonly autoDelete?: boolean;
  /** `notify_skip_followers` kwarg of `_notify_thread` (composer forward mode). */
  readonly skipFollowers?: boolean;
  /** `force_email_lang` kwarg of `_notify_thread_by_email` (mail_thread.py:3829): fallback lang when recipient has no active lang. */
  readonly forceEmailLang?: string;
}

/**
 * The models whose `_notify_get_recipients_groups`, rendering context, reply-to and headers overrides are ported here:
 * res.partner and calendar.event (mail's defaults), crm.lead (crm_lead.py:2082-2103: the deadline subtitle, which
 * message_notify's own `subtitles` replace, mail_thread.py:3852-3853, and the team alias as reply-to, which the
 * message's reply_to is computed from before), sale.order (sale_order.py:2208-2266), project.task, project.project
 * (project_project.py:958-969, :1253-1254), purchase.order (purchase_order.py:557-599), account.move, and the plain
 * mail.thread models on poc_erp without portal.mixin or `_notify_*` overrides.
 */
const NOTIFY_MODELS = new Set([
  'res.partner', 'calendar.event', 'crm.lead', 'sale.order', 'project.task', 'project.project', 'purchase.order', 'account.move',
  'stock.picking', 'stock.lot', 'stock.picking.batch', 'product.template', 'product.product', 'product.category',
  'account.payment', 'account.tax', 'account.account', 'account.analytic.account',
  'crm.team', 'crm.team.member', 'project.milestone', 'project.update', 'res.users', 'res.company', 'res.partner.bank',
]);
/** The portal.mixin models among them (sale_order.py:28, project_task.py:96, project_project.py:27, purchase_order.py:23, account_move.py:79). */
const PORTAL_MODELS = new Set(['sale.order', 'project.task', 'project.project', 'purchase.order', 'account.move']);
/** The portal models whose customer gets the portal_customer group's signed link here. project.task overrides
 * `_notify_get_recipients_groups` around it (handled at the groups below). project.project overrides `_portal_ensure_token`
 * to return '' and disables the button when privacy_visibility is not invited_users/portal. purchase.order overrides the
 * button url to get_confirm_url() and title to View Quotation / View Order. sale.order's override (sale_order.py:
 * 2208-2234) takes the buttons away under `proforma` (refused below) and titles a quotation's button "View Quotation",
 * which in en_US (the only language of a sale.order notification here) is mail's own `View %s` of its model
 * description ("Quotation" for draft and sent, `_get_model_description`). */
const SIGNED_CUSTOMER_MODELS = new Set(['account.move', 'sale.order', 'project.project', 'purchase.order']);

/** `urllib.parse.urlencode` (quote_plus) of `urls.url_encode(params, sort=True)` (mail_thread.py:4620): str() values. */
export function urlEncodeSorted(params: Record<string, string | number>): string {
  const q = (v: string): string => {
    let out = '';
    for (const b of Buffer.from(v, 'utf8')) {
      const c = String.fromCharCode(b);
      out += /[A-Za-z0-9_.~-]/.test(c) ? c : b === 0x20 ? '+' : `%${b.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
  };
  return Object.keys(params).sort().map((k) => `${q(k)}=${q(String(params[k]))}`).join('&');
}

/**
 * `tools.hash_sign(env, 'signup', [pid, [], None, 'signup'], expiration_hours)` (tools/misc.py:1823-1848) as
 * auth_signup res_partner.py:173-193 `_generate_signup_token` builds it for a partner without active users:
 * `datetime.now()` is the real clock (Odoo runs in UTC), the json is Python's (", " separators).
 */
export async function signupToken(env: Environment, partnerId: number): Promise<string> {
  const hours = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = 'auth_signup.signup.validity.hours'")).rows[0]?.value;
  const h = hours ? Number(hours) : 0;
  if (hours && !/^\s*\d+\s*$/.test(hours)) throw new NotPorted('auth_signup.signup.validity.hours that is not an integer');
  const expiration = Math.floor(Date.now() / 1000 + (h || 144) * 3600);
  const message = `[${partnerId}, [], null, "signup"]`;
  const secret = await databaseSecret(env);
  const digest = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(pyRepr(['signup', `1:${message}:${expiration}`]), 'utf8')).digest();
  const exp = Buffer.alloc(8);
  exp.writeBigUInt64LE(BigInt(expiration));
  return Buffer.concat([Buffer.from([1]), exp, digest, Buffer.from(message, 'utf8')]).toString('base64url');
}

/**
 * The fields `Base._flush` marks as written (mail/models/models.py:29-34) for an ORM write of `vals` on one record:
 * `Field.write` drops records whose cached value is unchanged (odoo/orm/fields.py `_filter_not_equal`), so only the
 * columns that change count, listed in the model's `_fields` order. `order` is that order for the columns the write
 * can touch, measured in an Odoo shell on poc_erp (res.partner: write_uid, write_date, signup_type; sale.order and
 * account.move: access_token, write_uid, write_date; project.task: access_token, write_date, write_uid).
 */
async function writeMarked(env: Environment, model: string, id: number, vals: Record<string, unknown>, order: readonly string[], marked: WrittenFields): Promise<void> {
  const table = env.reg.model(model).table;
  const cols = order.map(c => `"${c}"::text AS "${c}"`).join(', ');
  const read = async (): Promise<Record<string, string | null>> => (await env.cr.query<Record<string, string | null>>(`SELECT ${cols} FROM "${table}" WHERE id = $1`, [id])).rows[0] ?? {};
  const before = await read();
  const { write } = await import('../orm/write');
  await write(env.sudo(), model, [id], vals);
  const after = await read();
  const changed = order.filter(c => before[c] !== after[c]);
  if (!changed.length) return;
  const byId = (marked[model] ??= {});
  const prev = byId[String(id)] ?? [];
  byId[String(id)] = order.filter(c => prev.includes(c) || changed.includes(c));
}

const WRITE_ORDER: Readonly<Record<string, readonly string[]>> = {
  'res.partner': ['write_uid', 'write_date', 'signup_type'],
  'sale.order': ['access_token', 'write_uid', 'write_date'],
  'purchase.order': ['access_token', 'write_uid', 'write_date'],
  'account.move': ['access_token', 'write_uid', 'write_date'],
  'project.task': ['access_token', 'write_date', 'write_uid'],
};

/**
 * portal/models/mail_thread.py:24-36, evaluated while the groups are built (so only when someone is notified by
 * email): the customer (`_mail_get_partners`, models.py:163-201: `partner_id`) gets the record's access token
 * (`_portal_ensure_token`, portal_mixin.py:34-39, a sudo write of a uuid4; project_task.py:2358-2362 only for tasks
 * of portal projects; project_project.py:1253-1254 always returns '') and `signup_get_auth_param` (auth_signup
 * res_partner.py:93-110, on the sudo partner): in b2c scope a partner without an active user is written
 * `signup_type = 'signup'` (`signup_prepare` :115-118) and gets a signup token, a partner with one user its login.
 * With `signed`, the customer's access link is built (`_notify_get_action_link('view', access_token, pid, hash,
 * auth_*)`, mail_thread.py:4604-4624, the hash being portal mail_thread.py:65-77 `_sign_token`). Returns the customer.
 */
async function portalCustomerOf(env: Environment, model: string, resId: number, signed: boolean, baseUrl: string, marked: WrittenFields): Promise<{ id: number; link: string | null; button?: boolean; title?: string } | null> {
  const def = env.reg.model(model);
  const row = (await env.cr.query<{ c: number | null; t: string | null; v: string | null }>(
    model === 'project.task'
      ? `SELECT t.partner_id AS c, t.access_token AS t, p.privacy_visibility AS v FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id WHERE t.id = $1`
      : model === 'project.project'
        ? `SELECT partner_id AS c, access_token AS t, privacy_visibility AS v FROM project_project WHERE id = $1`
        : `SELECT partner_id AS c, access_token AS t, NULL::text AS v FROM "${def.table}" WHERE id = $1`, [resId])).rows[0];
  const customer = row?.c ?? null;
  if (customer === null) return null;
  // project_task.py:1723-1728: a task of a portal project gives its customer the access button (the signed link with
  // the task's token, ensured below); invited_users projects have no token (:2358-2362) and refuse at the caller
  const sign = signed || (model === 'project.task' && row!.v === 'portal');
  let token = row!.t;
  // project_project.py:1253-1254 `_portal_ensure_token` returns '' without generating/writing access_token
  if (!token && model !== 'project.project' && (model !== 'project.task' || row!.v === 'portal')) {
    token = crypto.randomUUID();
    const order = WRITE_ORDER[model];
    if (order === undefined) throw new NotPorted(`portal token of ${model} (field order of the Store version)`);
    await writeMarked(env, model, resId, { access_token: token }, order, marked);
  }
  // `signup_get_auth_param` (:97-98) refuses users neither internal nor admin, but portal mail_thread.py:35 calls it on
  // `customer.sudo()`, whose `env.is_admin()` is true: a portal author passes too
  const scope = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = 'auth_signup.invitation_scope'")).rows[0]?.value || 'b2b';
  // `partner.user_ids`: active users in res.users order (name, login, mail res_users.py `_order`)
  const users = (await env.cr.query<{ login: string }>(
    'SELECT u.login FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.partner_id = $1 AND u.active ORDER BY p.name, u.login', [customer])).rows;
  const params: Record<string, string | number> = {};
  if (scope === 'b2c' && !users.length) {
    await writeMarked(env, 'res.partner', customer, { signup_type: 'signup' }, WRITE_ORDER['res.partner']!, marked);
    if (sign) params['auth_signup_token'] = await signupToken(env, customer);
  } else if (users.length) {
    if (users.length > 1) throw new NotPorted('signup parameters of a customer with several users (res.users order)');
    params['auth_login'] = users[0]!.login;
  }
  if (!sign) return { id: customer, link: null };
  if (model === 'purchase.order') {
    if (!token) throw new NotPorted('purchase.order portal link without an access token');
    const st = (await env.cr.query<{ state: string | null }>('SELECT state FROM purchase_order WHERE id = $1', [resId])).rows[0]?.state ?? 'draft';
    const lang = env.lang ?? 'en_US';
    const title = env.context['is_reminder']
      ? translateLang(lang, 'View', 'purchase')
      : translateLang(lang, ['draft', 'sent'].includes(st) ? 'View Quotation' : 'View Order', 'purchase');
    const link = `${baseUrl}/my/purchase/${resId}?access_token=${encodeURIComponent(token)}`;
    return { id: customer, link, button: true, title };
  }
  if (model !== 'project.project' && !token) throw new NotPorted('signed access link without an access token');
  const db = requestOfCursor(env.cr)?.db;
  if (!db || !/^[A-Za-z0-9_.-]+$/.test(db)) throw new NotPorted('signed access link for this database name (repr)');
  const secret = await databaseSecret(env);
  const hash = createHmac('sha256', Buffer.from(secret, 'utf8')).update(Buffer.from(pyRepr([db, token ?? false, customer]), 'utf8')).digest('hex');
  const link = `${baseUrl}/mail/view?${urlEncodeSorted({ model, res_id: resId, access_token: model === 'project.project' ? '' : token!, pid: customer, hash, ...params })}`;
  const button = model === 'project.project' ? (row!.v === 'invited_users' || row!.v === 'portal') : true;
  return { id: customer, link, button };
}

/**
 * account_move.py:8099-8123 `_notify_by_email_prepare_rendering_context` (the subtitles: the move and its partner, the
 * amount and due date of an unpaid invoice) and account_peppol account_move.py:142-163 (a company on Peppol adds the
 * Peppol status to the layout: refused).
 */
async function moveSubtitles(env: Environment, resId: number): Promise<string[]> {
  const m = (await env.cr.query<{ move_type: string; partner: string | null; due: string | null; payment_state: string | null; amount_total: string; currency_id: number; proxy: string | null }>(
    `SELECT m.move_type, p.name AS partner, to_char(m.invoice_date_due, 'YYYY-MM-DD') AS due, m.payment_state, m.amount_total::text, m.currency_id,
            c.account_peppol_proxy_state AS proxy
       FROM account_move m LEFT JOIN res_partner p ON p.id = m.partner_id JOIN res_company c ON c.id = m.company_id WHERE m.id = $1`, [resId])).rows[0]!;
  if (['sender', 'smp_registration', 'receiver'].includes(String(m.proxy))) throw new NotPorted('invoice notification of a company on Peppol (peppol_info)');
  const display = (await env.sudo().model('account.move').displayName([resId])).get(resId) ?? '';
  const out = [m.partner ? `${display} - ${m.partner}` : display];
  if (['out_invoice', 'out_refund', 'in_invoice', 'in_refund', 'out_receipt', 'in_receipt'].includes(m.move_type)) {
    const amount = Number(m.amount_total);
    if (!amount) throw new NotPorted('invoice notification of a zero total (tax_totals)');
    const { formatAmount } = await import('../models/account_taxes');
    const formatted = await formatAmount(env, amount, m.currency_id);
    if (m.due && m.payment_state !== 'in_payment' && m.payment_state !== 'paid') {
      const { formatDate } = await import('../models/invoicing_computes');
      // account_move.py:8112-8116 `_('%(amount)s due\N{NO-BREAK SPACE}%(date)s', ...)` in the rendering language
      out.push(translateLang(env.lang, '%(amount)s due\u00a0%(date)s', 'account').replace('%(amount)s', formatted).replace('%(date)s', await formatDate(env, m.due)));
    } else out.push(formatted);
  }
  return out;
}

/**
 * mail_thread.py:3528-3592 `_notify_thread_by_inbox`: one `sent` inbox notification per recipient in (partner, user)
 * order, then (the returned function, at the caller's precommit) a Store per active user of those partners
 * (`res.users` `_order`), `mail.message/notification` with the message id and the message's fields as the user
 * sees them with the inbox fields (`message.with_user(user)`, `allowed_company_ids=[]`). Web push
 * (`_notify_thread_by_web_push` :4123, the inbox recipients' devices) is not ported: refused when one has a device.
 */
async function notifyByInbox(ctx: RequestContext, env: Environment, messageId: number, authorId: number | null,
  recipients: readonly Recipient[]): Promise<NotifyResult['inbox']> {
  const pairs = recipients.filter(r => r.notif === 'inbox' && r.uid !== null).map(r => [r.id, r.uid!] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const pids = pairs.map(p => p[0]);
  if ((await env.cr.query('SELECT 1 FROM mail_push_device WHERE partner_id = ANY($1::int[]) LIMIT 1', [pids])).rows.length) {
    throw new NotPorted('web push notification of inbox recipients with a device');
  }
  const users = await createInboxNotifications(env, messageId, authorId, pids);
  return async (written) => {
    const { messageFields } = await import('./thread');
    for (const uid of users) {
      const userEnv = env.withUser(uid).withContext({ ...env.context, uid, allowed_company_ids: [] });
      const store = new Store();
      await messageFields(userEnv, [messageId], store, true, { inbox: true });
      const data = await store.asDict(env.cr);
      data['__store_version__'] = await storeVersion(env.cr, written);
      await busSend(ctx, env, { model: 'res.users', id: uid }, 'mail.message/notification', { message_id: messageId, store_data: data });
    }
  };
}

/**
 * mail_thread.py:3539-3562: the `sent` inbox notifications of the partners (sorted by the caller), then the active
 * users of those partners (`browse(pids).sudo().with_context(active_test=True).user_ids`: res.users `_order` per
 * partner, in the partners' order, first appearance), whose Stores the caller sends.
 */
export async function createInboxNotifications(env: Environment, messageId: number, authorId: number | null, pids: readonly number[]): Promise<number[]> {
  for (const pid of pids) {
    await env.cr.query(
      `INSERT INTO mail_notification (author_id, mail_message_id, notification_status, notification_type, res_partner_id)
       VALUES ($1, $2, 'sent', 'inbox', $3)`, [authorId, messageId, pid]);
  }
  const users: number[] = [];
  for (const pid of pids) {
    const ids = (await env.cr.query<{ id: number }>('SELECT id FROM res_users WHERE partner_id = $1 AND active', [pid])).rows.map(r => r.id);
    const ordered = ids.length > 1 ? await env.sudo().model('res.users').search(cond('id', 'in', ids), { order: 'name, login' }) : ids;
    for (const u of ordered) if (!users.includes(u)) users.push(u);
  }
  return users;
}

function refuse(what: string): never {
  throw new NotPorted(what);
}

/** `_notify_thread(message)` for a message on `model`/`resId` (NOTIFY_MODELS and the compiled thread models). */
export async function notifyThread(ctx: RequestContext, env: Environment, model: string, resId: number, messageId: number, opts: NotifyOptions = {}): Promise<NotifyResult> {
  const marked: WrittenFields = {};
  let inbox: NotifyResult['inbox'] = async () => undefined;
  const none: NotifyResult = { messageWritten: [], recordsWritten: marked, send: async () => undefined, inbox: (w) => inbox(w) };
  const msg = (await env.cr.query<{ subtype_id: number; message_type: string; subject: string | null; body: string; author_id: number | null; email_add_signature: boolean | null; record_company_id: number | null; layout: string | null }>(
    'SELECT subtype_id, message_type, subject, body, author_id, email_add_signature, record_company_id, email_layout_xmlid AS layout FROM mail_message WHERE id = $1', [messageId])).rows[0]!;
  let recipients = await recipientsOf(env, model, resId, messageId, msg.subtype_id, msg.message_type === 'user_notification' || Boolean(opts.skipFollowers), Boolean(opts.notifyAuthorMention));
  const def = env.reg.model(model);
  // :4626-4634 `_notify_thread_with_out_of_office`, for comments and emails only: the internal users among the
  // message's partners, the record responsible (:4723-4726) and the parent message's internal author (:4728-4731)
  // may answer out of office (refused when one of them is)
  if (msg.message_type === 'comment' || msg.message_type === 'email') {
    const responsible = def.fields.get('user_id')?.relation === 'res.users' && def.fields.get('user_id')?.column
      ? (await env.cr.query<{ u: number | null }>(`SELECT user_id AS u FROM "${def.table}" WHERE id = $1`, [resId])).rows[0]?.u ?? null : null;
    const ooo = (await env.cr.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM res_users u WHERE u.out_of_office_from IS NOT NULL AND u.active AND (u.id = $1
          OR u.partner_id IN (SELECT res_partner_id FROM mail_message_res_partner_rel WHERE mail_message_id = $2)
          OR u.partner_id IN (SELECT res_partner_id FROM mail_message_res_partner_cc_rel WHERE mail_message_id = $2)
          OR u.partner_id IN (SELECT p.author_id FROM mail_message m JOIN mail_message p ON p.id = m.parent_id WHERE m.id = $2))
          AND u.partner_id IS DISTINCT FROM $3`,
      [responsible, messageId, msg.author_id])).rows[0];
    if (Number(ooo?.n ?? 0) > 0) throw new NotPorted('out of office answers');
  }
  if (!recipients.length) return none;
  if (recipients.some(r => r.notif === 'inbox')) {
    if (!opts.inbox) throw new NotPorted('inbox notifications outside a post or an activity assignment (their bus Store)');
    inbox = await notifyByInbox(ctx, env, messageId, msg.author_id, recipients);
  }
  // :3628 `_notify_thread_by_email` notifies the recipients by email only
  recipients = recipients.filter(r => r.notif === 'email');
  if (!recipients.length) return none;
  // a mail.thread model a new module introduces keeps mail's `_notify_*` methods when its build gave it the generic
  // chatter (compiler/oc/build.py `thread_chatter` refuses overrides of mail's methods and the mixins that change them)
  if (!NOTIFY_MODELS.has(model) && !isCompiledThread(model)) {
    const why = chatterRefusal(model);
    throw new NotPorted(`email notifications on ${model}${why ? ` (${why})` : ''}`);
  }
  // sale_order.py:2208-2234: the proforma context takes the buttons away from customer groups (not ported)
  if (model === 'sale.order' && env.context['proforma']) throw new NotPorted('sale.order notification with proforma in the context');
  // `_notify_thread_by_email` (:3594) renders `msg_vals['email_layout_xmlid'] or message.email_layout_xmlid`: the
  // default layout, the light one, the responsible-signature layout, and the account_peppol invoice layout are ported
  const layoutXmlid = msg.layout;
  if (layoutXmlid !== null && ![
    'mail.mail_notification_layout',
    'mail.mail_notification_light',
    'mail.mail_notification_layout_with_responsible_signature',
    'account_peppol.mail_notification_layout_with_responsible_signature_and_peppol',
  ].includes(layoutXmlid)) {
    throw new NotPorted(`notification email layout ${layoutXmlid}`);
  }
  const light = Boolean(opts.light) || layoutXmlid === 'mail.mail_notification_light';
  const responsibleOnly = layoutXmlid === 'mail.mail_notification_layout_with_responsible_signature';
  const responsiblePeppol = layoutXmlid === 'account_peppol.mail_notification_layout_with_responsible_signature_and_peppol';
  const baseUrl = (await env.cr.query<{ value: string }>("SELECT value FROM ir_config_parameter WHERE key = 'web.base.url'")).rows[0]?.value ?? '';
  // portal/models/mail_thread.py:15-55 on portal.mixin models: the customer's token, signature and signup parameters
  const portalCustomer = PORTAL_MODELS.has(model) ? await portalCustomerOf(env, model, resId, SIGNED_CUSTOMER_MODELS.has(model), baseUrl, marked) : null;
  // account_move.py:7150-7172 (after portal's groups): a non-entry move ensures its token and puts the partners added
  // to the message (not the move's partner, not internal users) first, with the plain access link
  let moveAccessLink: string | null = null;
  let moveRecipients: Set<number> = new Set();
  let movePartner: number | null = null;
  if (model === 'account.move') {
    const mv = (await env.cr.query<{ move_type: string; partner_id: number | null; access_token: string | null }>('SELECT move_type, partner_id, access_token FROM account_move WHERE id = $1', [resId])).rows[0]!;
    movePartner = mv.partner_id;
    if (mv.move_type !== 'entry') {
      let token = mv.access_token;
      if (!token) {
        token = crypto.randomUUID();
        await writeMarked(env, model, resId, { access_token: token }, WRITE_ORDER['account.move']!, marked);
      }
      moveAccessLink = `${baseUrl}/mail/view?${urlEncodeSorted({ model, res_id: resId, access_token: token })}`;
      moveRecipients = new Set((await env.cr.query<{ id: number }>('SELECT res_partner_id AS id FROM mail_message_res_partner_rel WHERE mail_message_id = $1', [messageId])).rows.map(r => r.id));
    }
  }
  // project.task `_notify_get_recipients_groups` (project_task.py:1693-1726): 'group_project_user' (default options:
  // access button) goes first, the 'user' group loses its button; tasks of a project add portal groups and the
  // project's reply-to (not ported)
  let projectUserGroup: number | null = null;
  let taskProject: number | null = null;
  let allowedPortal = false;
  if (model === 'project.task') {
    // a project adds the 'allowed_portal_users' group first for invited_users/portal privacy (portal recipients
    // refuse below) and its alias as reply-to (`_notify_get_reply_to` :1732-1739: without alias domains, which refuse
    // below, the default reply-to)
    const task = (await env.cr.query<{ p: number | null; c: number | null; v: string | null }>(
      `SELECT t.project_id AS p, t.partner_id AS c, p.privacy_visibility AS v FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id WHERE t.id = $1`, [resId])).rows[0];
    taskProject = task?.p ?? null;
    allowedPortal = task?.v === 'invited_users' || task?.v === 'portal';
    projectUserGroup = (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'project' AND name = 'group_project_user'")).rows[0]?.res_id ?? null;
  }
  // :3823-3831 recipients by language (inactive languages fall back to force_email_lang or env language); each language
  // renders with `self.with_context(lang=lang)`. One language per notification is ported.
  const envLang = env.lang ?? 'en_US';
  const fallbackLang = opts.forceEmailLang || envLang;
  const langs = new Set<string>();
  for (const r of recipients) {
    const active = r.lang ? (await env.cr.query('SELECT 1 FROM res_lang WHERE code = $1 AND active', [r.lang])).rows.length > 0 : false;
    langs.add(active ? r.lang! : fallbackLang);
  }
  if (langs.size > 1) throw new NotPorted('notification emails in several languages');
  const lang = langs.size ? [...langs][0]! : fallbackLang;
  if (lang !== envLang) env = env.withContext({ ...env.context, lang });
  if (Number((await env.cr.query<{ n: string }>('SELECT count(*)::text n FROM mail_alias_domain')).rows[0]?.n ?? 0) > 0) throw new NotPorted('alias domains (reply-to, bounce)');
  for (const r of recipients) if (!r.emailNormalized) throw new NotPorted('email notification to a partner without a valid email');
  if (new Set(recipients.map(r => r.emailNormalized)).size !== recipients.length) throw new NotPorted('duplicate recipient emails (mail_dup)');
  // groups (:4458-4488): first match; portal is active with access button on portal.mixin models
  // (project.project disables the button when privacy_visibility is not invited_users/portal; project.task uses allowed_portal_users)
  let projectPortalPrivacy = true;
  if (model === 'project.project') {
    const pv = (await env.cr.query<{ v: string | null }>('SELECT privacy_visibility AS v FROM project_project WHERE id = $1', [resId])).rows[0]?.v ?? null;
    projectPortalPrivacy = pv === 'invited_users' || pv === 'portal';
  }
  const groups: { name: string; button: boolean; members: Recipient[]; url?: string; title?: string }[] = projectUserGroup === null
    ? [
      { name: 'user', button: true, members: [] },
      ...(PORTAL_MODELS.has(model) ? [{ name: 'portal', button: model === 'project.project' ? projectPortalPrivacy : true, members: [] as Recipient[] }] : []),
      { name: 'customer', button: false, members: [] },
    ]
    : [{ name: 'group_project_user', button: true, members: [] }, { name: 'user', button: false, members: [] }, { name: 'customer', button: false, members: [] }];
  // project_task.py:1714-1721: portal users of invited_users/portal projects come first, with the access button
  const allowedPortalGroup: { name: string; button: boolean; members: Recipient[] } = { name: 'allowed_portal_users', button: true, members: [] };
  if (allowedPortal) groups.unshift(allowedPortalGroup);
  // the move's groups in front: additional_intended_recipient (account), then portal_customer (portal)
  const customerGroup: { name: string; button: boolean; members: Recipient[]; url?: string; title?: string } = {
    name: 'portal_customer', button: portalCustomer?.button ?? true, members: [], ...(portalCustomer?.title ? { title: portalCustomer.title } : {}),
  };
  const additionalGroup: { name: string; button: boolean; members: Recipient[]; url?: string; title?: string } = { name: 'additional_intended_recipient', button: true, members: [] };
  if (portalCustomer?.link) { customerGroup.url = portalCustomer.link; groups.unshift(customerGroup); }
  // project_task.py:1699-1730 over portal's (mail_thread.py:15-55): the task's customer group comes after
  // group_project_user, without the access button outside portal projects (the signup parameters were prepared above)
  const taskCustomerGroup: { name: string; button: boolean; members: Recipient[]; url?: string; title?: string } = { name: 'portal_customer', button: false, members: [] };
  if (model === 'project.task' && portalCustomer !== null) groups.splice(groups.findIndex(g => g.name === 'group_project_user') + 1, 0, taskCustomerGroup);
  const inProjectUserGroup = async (uid: number): Promise<boolean> => (await env.cr.query(
    `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1
       UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id) SELECT 1 FROM g WHERE id = $2`, [uid, projectUserGroup])).rows.length > 0;
  if (moveAccessLink !== null) { additionalGroup.url = moveAccessLink; groups.unshift(additionalGroup); }
  for (const r of recipients) {
    // portal/models/mail_thread.py:15-55: the record's customer matches the 'portal_customer' group first (a signed
    // access link with the portal token, hash and signup parameters), whatever its type or following
    if (moveAccessLink !== null && moveRecipients.has(r.id) && r.id !== movePartner && r.type !== 'user') {
      additionalGroup.members.push(r);
      continue;
    }
    if (portalCustomer !== null && r.id === portalCustomer.id) {
      if (model === 'project.task') {
        if (allowedPortal && portalCustomer.link === null) throw new NotPorted('project.task notification to its customer in an invited_users project (access button without token)');
        if (portalCustomer.link !== null) { taskCustomerGroup.button = true; taskCustomerGroup.url = portalCustomer.link; }
        // group_project_user is matched first
        if (!(r.type === 'user' && r.uid !== null && await inProjectUserGroup(r.uid))) {
          taskCustomerGroup.members.push(r);
          continue;
        }
      } else {
        if (portalCustomer.link === null) throw new NotPorted(`${model} notification to its customer (portal_customer group: signed access link and signup parameters)`);
        customerGroup.members.push(r);
        continue;
      }
    }
    if (r.type === 'user') {
      if (projectUserGroup !== null) {
        if (r.uid === null) throw new NotPorted('notification recipient typed user without a user');
        const name = (await inProjectUserGroup(r.uid)) ? 'group_project_user' : 'user';
        groups.find(g => g.name === name)!.members.push(r);
      } else groups.find(g => g.name === 'user')!.members.push(r);
    } else if (r.type === 'portal' && allowedPortal) {
      allowedPortalGroup.members.push(r);
    } else if (r.type === 'portal' && PORTAL_MODELS.has(model) && model !== 'project.task') {
      groups.find(g => g.name === 'portal')!.members.push(r);
    } else if (r.type === 'portal' || r.isFollower) {
      if (PORTAL_MODELS.has(model) && r.type === 'portal') throw new NotPorted(`${model} notification to portal users`);
      continue;
    } else {
      groups[groups.length - 1]!.members.push(r);
    }
  }
  const active = groups.filter(g => g.members.length);
  if (!active.length) return none;
  // rendering context (:3864-3962)
  // sale_order.py:2282-2285 `_get_model_description`: the order's `type_name` (:1209-1214, in the rendering language)
  const saleOrder = model === 'sale.order' ? (await env.cr.query<{ name: string; state: string | null; partner: string | null; amount_total: string | null; currency_id: number | null }>(
    `SELECT o.name, o.state, p.name AS partner, o.amount_total::text AS amount_total, o.currency_id
       FROM sale_order o LEFT JOIN res_partner p ON p.id = o.partner_id WHERE o.id = $1`, [resId])).rows[0] : undefined;
  const typeName = saleOrder ? translateLang(lang, ['draft', 'sent', 'cancel'].includes(saleOrder.state ?? '') ? 'Quotation' : 'Sales Order', 'sale') : null;
  if (saleOrder && ['draft', 'sent'].includes(saleOrder.state ?? '')) {
    customerGroup.title = translateLang(lang, 'View Quotation', 'sale');
  }
  const modelDescription = opts.modelDescription ?? typeName ?? (await env.cr.query<{ name: string }>("SELECT COALESCE(name->>$2, name->>'en_US') AS name FROM ir_model WHERE model = $1", [model, lang])).rows[0]?.name ?? '';
  const displayName = (await env.sudo().model(model).displayName([resId])).get(resId) ?? '';
  const recordName = textwrapShorten(displayName, 100, '...');
  const subtype = (await env.cr.query<{ internal: boolean | null }>('SELECT internal FROM mail_message_subtype WHERE id = $1', [msg.subtype_id])).rows[0];
  const company = (def.fields.get('company_id')?.column ? (await env.cr.query<{ company_id: number | null }>(`SELECT company_id FROM "${def.table}" WHERE id = $1`, [resId])).rows[0]?.company_id : null) ?? await env.company();
  const colors = (await env.cr.query<{ p: string | null; s: string | null; name: string; phone: string | null; email: string | null; website: string | null }>(
    `SELECT c.email_primary_color AS p, c.email_secondary_color AS s, c.name, p.phone, p.email, p.website
       FROM res_company c JOIN res_partner p ON p.id = c.partner_id WHERE c.id = $1`, [company])).rows[0];
  // mail_thread.py:3905-3906 `author.main_user_id` (base res_partner.py:517-531): the current user for its own partner,
  // else the partner's active users, internal first then by id; OdooBot's partner without one has the (archived) root
  const authorUser = msg.author_id ? (await env.cr.query<{ signature: string | null; share: boolean | null }>(
    `SELECT signature, share FROM res_users u WHERE partner_id = $1 AND (u.active OR u.id = $2
        OR (u.id = 1 AND $1 = (SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'partner_root')
          AND NOT EXISTS (SELECT 1 FROM res_users a WHERE a.partner_id = $1 AND a.active)))
      ORDER BY u.id = $2 DESC, share, id LIMIT 1`, [msg.author_id, env.uid])).rows[0] : undefined;
  // mail_templates_email_layouts.xml:11-14: show_footer = force_footer or (allow_footer and show_header and an
  // internal author user); the footer variant with phone, email and website all set
  const footerOf = (showHeader: boolean): { name: string; phone: string; email: string; website: string } | null => {
    if (!opts.forceFooter && !(opts.allowFooter && showHeader && authorUser && !authorUser.share)) return null;
    if (!colors?.phone || !colors.email || !colors.website) throw new NotPorted('email footer without company phone, email or website');
    return { name: colors.name, phone: colors.phone, email: colors.email, website: colors.website };
  };
  // mail_templates_email_layouts.xml:182-183: responsible user's signature for mail_notification_layout_with_responsible_signature
  let responsibleSignature: string | null = null;
  if ((responsibleOnly || responsiblePeppol) && msg.email_add_signature && env.uid !== 1 && def.fields.get('user_id')?.relation === 'res.users') {
    // the template tests `record.env.user._is_superuser()` (uid 1), not sudo
    if (!def.fields.get('user_id')?.column) throw new NotPorted(`responsible signature of a non-stored ${model}.user_id`);
    const ruid = (await env.cr.query<{ u: number | null }>(`SELECT user_id AS u FROM "${def.table}" WHERE id = $1`, [resId])).rows[0]?.u ?? null;
    if (ruid !== null) {
      const rsig = (await env.cr.query<{ s: string | null }>('SELECT signature AS s FROM res_users WHERE id = $1', [ruid])).rows[0]?.s ?? null;
      if (rsig && !isHtmlEmpty(rsig)) responsibleSignature = rsig;
    }
  }
  const signature = authorUser && msg.email_add_signature ? `<div>-- <br/>${authorUser.signature ?? ''}</div>` : null;
  const preview = messagePreview(msg.body);
  if (preview === null) throw new NotPorted('message preview longer than 190 characters');
  const subtitles = model === 'account.move' ? await moveSubtitles(env, resId) : [...(opts.subtitles ?? [opts.layoutRecordName ?? recordName])];
  if (saleOrder && opts.subtitles === undefined) {
    // sale_order.py:2236-2267 `_notify_by_email_prepare_rendering_context`: "<name> - <customer>" and the total
    // (format_amount in the rendering language) unless it is zero
    subtitles.splice(0, subtitles.length, saleOrder.partner ? `${saleOrder.name} - ${saleOrder.partner}` : saleOrder.name);
    if (Number(saleOrder.amount_total ?? 0)) {
      if (saleOrder.currency_id === null) throw new NotPorted('sale.order notification without a currency');
      const { formatAmount } = await import('../models/account_taxes');
      subtitles.push(await formatAmount(env, Number(saleOrder.amount_total), saleOrder.currency_id));
    }
  }
  if (model === 'project.task' && opts.subtitles === undefined) {
    // project_task.py:1540-1561 `_notify_by_email_prepare_rendering_context`: the project and the stage (their names
    // in the rendering language)
    const t = (await env.cr.query<{ project: string | null; stage: string | null }>(
      `SELECT COALESCE(p.name->>$2, p.name->>'en_US') AS project, COALESCE(s.name->>$2, s.name->>'en_US') AS stage
         FROM project_task t LEFT JOIN project_project p ON p.id = t.project_id LEFT JOIN project_task_type s ON s.id = t.stage_id WHERE t.id = $1`, [resId, lang])).rows[0];
    const tr = (src: string): string => translateLang(lang, src, 'project');
    if (t?.project && t.stage) subtitles.push(tr('Project: %(project_name)s, Stage: %(stage_name)s').replace('%(project_name)s', t.project).replace('%(stage_name)s', t.stage));
    else if (t?.project) subtitles.push(tr('Project: %(project_name)s').replace('%(project_name)s', t.project));
    else if (t?.stage) subtitles.push(tr('Stage: %(stage_name)s').replace('%(stage_name)s', t.stage));
  }
  if (model === 'purchase.order' && opts.subtitles === undefined) {
    // purchase_order.py:580-599 `_notify_by_email_prepare_rendering_context`
    const po = (await env.cr.query<{ name: string; state: string | null; date_order: string | null; amount_total: string | null; currency_id: number | null }>(
      `SELECT name, state, to_char(date_order, 'YYYY-MM-DD') AS date_order, amount_total::text AS amount_total, currency_id FROM purchase_order WHERE id = $1`, [resId])).rows[0];
    if (po) {
      subtitles.splice(0, subtitles.length, po.name);
      if (['draft', 'sent'].includes(po.state ?? '')) {
        const { formatDate } = await import('../models/invoicing_computes');
        const dateStr = po.date_order ? await formatDate(env, po.date_order) : '';
        subtitles.push(translateLang(lang, 'Order\u00a0due\u00a0%(date)s', 'purchase').replace('%(date)s', dateStr));
      } else if (po.currency_id !== null) {
        const { formatAmount } = await import('../models/account_taxes');
        subtitles.push(await formatAmount(env, Number(po.amount_total ?? 0), po.currency_id));
      }
    }
  }
  if (model === 'crm.lead' && opts.subtitles === undefined) {
    // crm_lead.py:2090-2092 `_notify_by_email_prepare_rendering_context`: the deadline in the language's date format
    const deadline = (await env.cr.query<{ d: string | null }>('SELECT date_deadline::text AS d FROM crm_lead WHERE id = $1', [resId])).rows[0]?.d ?? null;
    if (deadline) {
      const fmt = (await env.cr.query<{ f: string }>('SELECT date_format AS f FROM res_lang WHERE code = $1', [lang])).rows[0]?.f ?? '%m/%d/%Y';
      const { strftimeDate } = await import('../models/crm_lead_notify');
      subtitles.push(translateLang(lang, 'Deadline: %s', 'crm').replace('%s', strftimeDate(deadline, fmt)));
    }
  }
  // base mail values (:4007-4092)
  let mailSubject = msg.subject || recordName || null;
  if (mailSubject) mailSubject = mailSubject.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/).join(' ');
  const references = await mailReferences(env, model, resId, messageId);
  const external = recipients.filter(r => r.active && r.emailNormalized && r.share).map(r => ({ addr: formatAddr(r.name ?? '', r.emailNormalized!), cc: r.isCc }));
  const headers: [string, string][] = [];
  if (external.length && external.length < 50) { // _CUSTOMER_HEADERS_LIMIT_COUNT
    headers.push(['X-Msg-To-Add', external.filter(e => !e.cc).map(e => e.addr).join(',')], ['X-Msg-Cc-Add', external.filter(e => e.cc).map(e => e.addr).join(',')]);
  }
  // mail_thread.py `_notify_by_email_get_headers`; project_task.py:1792-1800 puts the project first and the tags
  headers.push(['X-Odoo-Objects', taskProject !== null ? `project.project-${taskProject}, ,${model}-${resId}` : `${model}-${resId}`]);
  if (model === 'project.task') {
    // `','.join(self.tag_ids.mapped('name'))`: the tags as the cache holds them, the order a write or create of this
    // request left (src/orm/x2many_order.ts: LINK in command order after the old ids), else project.tags
    // `_order = "name"` of a database read; names in the posting env's language (before the per-language rendering,
    // mail_thread.py:3631)
    const rows = (await env.cr.query<{ id: number; n: string }>(
      `SELECT t.id, COALESCE(t.name->>$2, t.name->>'en_US') AS n FROM project_tags_project_task_rel r JOIN project_tags t ON t.id = r.project_tags_id
        WHERE r.project_task_id = $1 ORDER BY COALESCE(t.name->>$2, t.name->>'en_US')`, [resId, envLang])).rows;
    const names = new Map(rows.map(t => [t.id, t.n]));
    const tags = inX2manyCacheOrder(env.cr, 'project.task', 'tag_ids', resId, rows.map(t => t.id));
    if (tags.length) headers.push(['X-Odoo-Tags', tags.map(id => names.get(id)!).join(',')]);
  }
  // the layout's own terms (mail_templates_email_layouts.xml) in the rendering language (src/mail/view_terms.ts)
  const layoutTr = lang === 'en_US' ? (t: string): string => t : await viewTerms(env, ['mail.mail_notification_layout', 'mail.notification_preview']);
  const written: string[] = [];
  const mailIds: number[] = [];
  const notifs: { mail: number; r: Recipient }[] = [];
  // :3855-3861 `show_unfollow`: set by the first group with an internal follower among its recipients, kept for the
  // groups after it (the render values are shared)
  let showUnfollow = false;
  for (const g of active) {
    if (!showUnfollow) showUnfollow = g.members.some(r => r.isFollower && r.uid !== null && !r.ushare);
    const url = g.url ?? `${baseUrl}/mail/view?model=${encodeURIComponent(model)}&res_id=${resId}`;
    let body: string;
    if (light) {
      if (responsiblePeppol || opts.allowFooter) throw new NotPorted('light email layout with another layout or footer option');
      if (opts.forceHeader) throw new NotPorted('light email layout with a forced header');
      if (!colors?.phone || !colors.email || !colors.website) throw new NotPorted('light email layout without company phone, email or website');
      const logo = (await env.cr.query<{ d: boolean | null }>('SELECT uses_default_logo AS d FROM res_company WHERE id = $1', [company])).rows[0]?.d;
      if (!logo) throw new NotPorted('light email layout with a company logo');
      body = lightLayout({ lang, preview, modelDescription, recordName, buttonUrl: g.button ? url : null, body: msg.body, secondaryColor: colors.s || '#875A7B',
        company: { name: colors.name, phone: colors.phone, email: colors.email, website: colors.website }, showUnfollow,
        // the light layout's own terms (mail_templates_email_layouts.xml:94-167) in the rendering language
        tr: await viewTerms(env, ['mail.mail_notification_light', 'mail.notification_preview']) });
    } else {
      body = emailLayout({
        lang, subtypeInternal: Boolean(subtype?.internal), preview, subtitles, body: msg.body,
        // the responsible's signature (mail_templates_email_layouts.xml:182-183) replaces the author's
        signature: responsiblePeppol ? (responsibleSignature ? refuse('the record responsible\'s signature in the invoice layout') : null)
          : responsibleOnly ? null : signature,
        footer: footerOf(g.button || Boolean(opts.forceHeader)), responsiblePeppol: responsiblePeppol || responsibleOnly,
        forceHeader: Boolean(opts.forceHeader), showUnfollow,
        // mail_thread.py:4503-4506 `_('View %s', model_description)`, `_('View')` without one (or group title override)
        button: g.button ? { url, title: g.title ?? (modelDescription ? translateLang(lang, 'View %s', 'mail').replace('%s', () => modelDescription) : translateLang(lang, 'View', 'mail')) } : null,
        tr: layoutTr,
        primaryColor: colors?.p || '#FFFFFF', secondaryColor: colors?.s || '#875A7B',
      });
      // mail_notification_layout_with_responsible_signature has the same empty-signature whitespace as responsiblePeppol;
      // only when a responsible signature is actually rendered do we splice it in
      if (responsibleOnly && responsibleSignature !== null) {
        body = spliceResponsibleSignature(body, msg.body, responsibleSignature);
      }
    }
    const mailId = (await env.cr.query<{ id: number }>(
      `INSERT INTO mail_mail (mail_message_id, body_html, "references", headers, auto_delete, is_notification, state,
         create_uid, write_uid, create_date, write_date)
       VALUES ($1, $2, $3, $4, $6, TRUE, 'outgoing', $5, $5, now() AT TIME ZONE 'UTC', now() AT TIME ZONE 'UTC') RETURNING id`,
      [messageId, body, references, reprStrDict(headers), env.uid, opts.autoDelete ?? true])).rows[0]!.id;
    // mail.mail `subject` lives on the message (`_inherits`): written when it differs (:4057-4058)
    if (mailSubject !== (msg.subject || null) && !written.length) {
      const uidBefore = inDeferredFlush(env) ? (await env.cr.query<{ u: number | null }>('SELECT write_uid AS u FROM mail_message WHERE id = $1', [messageId])).rows[0]?.u ?? null : null;
      await env.cr.query(`UPDATE mail_message SET subject = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [messageId, mailSubject, env.uid]);
      noteRawWrite(env, 'mail.message', messageId, ['subject'], uidBefore);
      written.push('subject');
    }
    // :3667-3692 `recipients_ids + recipients_cc_ids`: the To partners, then the Cc ones (`recipient_cc_ids`, :4109)
    for (const r of [...g.members.filter(m => !m.isCc), ...g.members.filter(m => m.isCc)]) {
      await env.cr.query(`INSERT INTO ${r.isCc ? 'mail_mail_res_partner_cc_rel' : 'mail_mail_res_partner_rel'} (mail_mail_id, res_partner_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [mailId, r.id]);
      notifs.push({ mail: mailId, r });
    }
    mailIds.push(mailId);
  }
  for (const { mail, r } of notifs) {
    // `_notify_by_email_get_base_notification_values` (:4116): read, ready, email; read_date set by is_read
    await env.cr.query(
      `INSERT INTO mail_notification (author_id, mail_message_id, mail_mail_id, res_partner_id, mail_email_address,
         notification_type, notification_status, is_read, read_date)
       VALUES ($1, $2, $3, $4, $5, 'email', 'ready', TRUE, date_trunc('second', now() AT TIME ZONE 'UTC'))`,
      [msg.author_id, messageId, mail, r.id, r.emailNormalized]);
  }
  return {
    messageWritten: written,
    recordsWritten: marked,
    inbox: (w) => inbox(w),
    send: async () => {
      // mail_thread.py:3749-3751: the context's `mail_notify_force_send` decides over the caller's force_send (a server
      // action or a cron job runs with it False, mail/models/ir_actions_server.py:464-470): the mails stay outgoing
      if ('mail_notify_force_send' in env.context && !env.context['mail_notify_force_send']) return;
      // send_after_commit -> send() as superuser (mail_mail.py:745-750, :784-790, _postprocess_sent_message :286-325)
      const reason = await smtpConnectFailure();
      for (const mailId of mailIds) {
        await env.cr.query(`UPDATE mail_mail SET state = 'exception', failure_reason = $2, write_uid = 1, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [mailId, reason]);
        await env.cr.query(
          `UPDATE mail_notification SET notification_status = 'exception', failure_type = 'mail_smtp', failure_reason = NULL
            WHERE mail_mail_id = $1 AND notification_type = 'email' AND notification_status NOT IN ('sent', 'canceled')`, [mailId]);
      }
      const written: Record<string, Record<string, string[]>> = { 'mail.mail': {}, 'mail.notification': {} };
      for (const mailId of mailIds) written['mail.mail']![String(mailId)] = ['state', 'failure_reason', 'write_uid', 'write_date'];
      for (const n of (await env.cr.query<{ id: number }>('SELECT id FROM mail_notification WHERE mail_mail_id = ANY($1::int[]) ORDER BY id', [mailIds])).rows) {
        written['mail.notification']![String(n.id)] = ['notification_status', 'failure_type'];
      }
      await notifyFailure(env, messageId, written);
      void ctx;
    },
  };
}


