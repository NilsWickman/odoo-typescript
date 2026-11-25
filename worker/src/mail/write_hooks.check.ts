/** Integration check of the mail WriteHooks against a poc_corpus scratch copy, called as WRITE_HOOKS.md specifies.
 * Prints the mail rows the scenario produces (rolled back) for comparison with Odoo on the same copy:
 * ODOO_TEST_DB=dev_mail node --experimental-transform-types --import ./test/register.mjs src/mail/write_hooks.check.ts <case>
 */
import { readFileSync } from 'node:fs';
import { Cursor } from '../db';
import { createEnvironment } from '../orm/env';
import { setGenMetadataLoader, type GenMetadata } from '../orm/registry';
import { hooksOf } from '../orm/hooks';
import type { Environment } from '../orm/types';
import '../models/partner';
import './write_hooks';

const database = process.env['ODOO_TEST_DB'];
if (!database || !/^dev_[a-zA-Z0-9_]+$/.test(database)) throw new Error('Set ODOO_TEST_DB to a dev_* scratch copy');
setGenMetadataLoader(async () => (JSON.parse(readFileSync(new URL('../../gen/out/models.json', import.meta.url).pathname, 'utf8')) as { models: GenMetadata }).models);
const cr = new Cursor({ SLOTS: '{}', PG_DSN_TEMPLATE: 'postgresql://track_rw:track_rw@127.0.0.1:5433/{db}' } as import('../env').Env, database);

async function create(env: Environment, model: string, vals: Record<string, unknown>): Promise<number> {
  const hooks = hooksOf(model).write ?? [];
  const list = [vals];
  for (const h of hooks) await h.beforeCreate?.(env, list);
  const cols = Object.keys(vals);
  const id = (await cr.query<{ id: number }>(`INSERT INTO ${env.reg.model(model).table} (${cols.map(c => `"${c}"`).join(',')}, create_uid, write_uid, create_date, write_date)
    VALUES (${cols.map((_c, i) => `$${i + 2}`).join(',')}, $1, $1, now() at time zone 'UTC', now() at time zone 'UTC') RETURNING id`, [env.uid, ...cols.map(c => vals[c])])).rows[0]!.id;
  for (const h of hooks) await h.afterCreate?.(env, [id], list);
  return id;
}
async function write(env: Environment, model: string, ids: number[], vals: Record<string, unknown>): Promise<void> {
  const hooks = hooksOf(model).write ?? [];
  for (const h of hooks) await h.beforeWrite?.(env, ids, vals);
  const cols = Object.keys(vals);
  const old = new Map<number, Record<string, unknown>>();
  await cr.query(`UPDATE ${env.reg.model(model).table} SET ${cols.map((c, i) => `"${c}"=$${i + 2}`).join(',')}, write_date=now() at time zone 'UTC' WHERE id = ANY($1::int[])`, [ids, ...cols.map(c => vals[c])]);
  for (const h of hooks) await h.afterWrite?.(env, ids, vals, old);
}

const ctx = { lang: process.env['LANG_CODE'] ?? 'en_US', tz: 'Europe/Brussels', uid: 2, allowed_company_ids: [1], default_is_company: true };
try {
  const env = await createEnvironment({ cr, uid: 2, context: ctx });
  const before = (await cr.query<{ id: number }>('SELECT max(id) AS id FROM mail_message')).rows[0]!.id;
  const kase = process.argv[2] ?? 's2';
  if (kase === 's2') {
    const id = await create(env, 'res.partner', { name: 'Night Owl Ltd', email: 'hello@nightowl.example', phone: '+32 2 555 01 99', street: '1 Moon Street', city: 'Bruxelles', lang: 'en_US', is_company: true, active: true, type: 'contact', commercial_company_name: 'Night Owl Ltd', complete_name: 'Night Owl Ltd' });
    await cr.query('UPDATE res_partner SET commercial_partner_id=id WHERE id=$1', [id]);
    await write(env, 'res.partner', [id], { phone: '+32 2 555 02 00' });
  } else if (kase === 'multi') {
    await write(env, 'res.partner', [16], { phone: '+1 999', name: "Azure & 'X' <y>", email: 'a@b.c', vat: 'BE0477472701', commercial_company_name: "Azure & 'X' <y>" });
  } else if (kase === 'address') {
    await write(env, 'res.partner', [28], { street: '9 Other St', country_id: 21, parent_id: 10, vat: 'US12345673', commercial_company_name: 'Acme Corporation' });
  }
  const rows = (await cr.query('SELECT res_id, body, message_type, subtype_id, author_id, email_from, reply_to, is_internal, email_add_signature, subject, record_company_id FROM mail_message WHERE id > $1 ORDER BY id', [before])).rows;
  const fol = (await cr.query('SELECT res_model,res_id,partner_id FROM mail_followers WHERE id > (SELECT max(id) FROM mail_followers) - 0 ORDER BY id')).rows;
  console.log(JSON.stringify({ messages: rows, followers: fol }));
} finally { await cr.rollback(); await cr.close(); }
