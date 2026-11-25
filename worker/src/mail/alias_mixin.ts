/**
 * mail.alias.mixin (odoo/addons/mail/models/mail_alias_mixin.py, mail_alias_mixin_optional.py) pieces shared by the
 * models that inherit it: the record-agnostic and the record creation values (`_alias_get_creation_values`
 * :186-196) and the post-create write of those values on each record's alias (:99-103). Model overrides of
 * `_alias_get_creation_values` are passed as `extra` (project.project here; crm.team has its own in
 * src/models/crm_team.ts and could move onto this).
 */
import { NotPorted, UserError } from '../errors';
import type { Environment } from '../orm/types';
import { write, type WriteFn } from '../orm/write';
import { unlink } from '../orm/unlink';
import { create } from '../orm/create';
import { registerHooks } from '../orm/hooks';
import { and, cond, or } from '../orm/domain';
import type { Domain } from '../orm/types';
import { hasModelAccess } from '../web/groups';
import { translate } from '../models/util';
import { formatList } from '../models/display_names';

/** mail_alias_mixin_optional.py:19 ALIAS_WRITEABLE_FIELDS. */
export const ALIAS_WRITEABLE_FIELDS: readonly string[] = ['alias_domain_id', 'alias_name', 'alias_contact', 'alias_defaults', 'alias_bounced_content'];

/** mail_alias.py:366-393 `_sanitize_alias_name` (left part only, is_email=False). */
export function sanitizeAliasName(name: unknown): string | false {
  let s = typeof name === 'string' ? name.trim() : '';
  if (s) {
    // tools/misc.py:652 remove_accents: NFKD without combining marks
    s = s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().split('@')[0]!;
    s = s.replace(/^\.+|\.+$|\.+(?=\.)/g, '');
    s = s.replace(/[^\p{L}\p{N}_!#$%&'*+\-/=?^`{|}~.]+/gu, '-');
    s = s.replace(/[^\x00-\x7f]/g, '?'); // encode('ascii', errors='replace')
  }
  return s.trim() ? s : false;
}

/**
 * mail_alias.py:302-358 `_check_unique`: the (name, domain) pairs are unique among themselves and against the other
 * aliases (`selfIds` excluded), else Odoo's UserError naming the alias already using the name and its owner.
 */
export async function checkAliasUnique(env: Environment, names: readonly (string | false)[], domains: readonly (number | false)[],
  selfIds: readonly number[]): Promise<void> {
  if (names.length !== domains.length) throw new NotPorted('mail.alias _check_unique with incoherent lists (ValueError)');
  const byDomain = new Map<number | false, string[]>();
  for (let i = 0; i < names.length; i++) {
    const name = names[i]!, domain = domains[i]!;
    if (!name) continue; // a void name neither checks nor adds its domain (defaultdict keys of the names only)
    const list = byDomain.get(domain) ?? [];
    if (list.includes(name)) {
      throw new UserError(translate(env, 'Email aliases %(alias_name)s cannot be used on several records at the same time. Please update records one by one.', 'mail')
        .replace('%(alias_name)s', name));
    }
    list.push(name);
    byDomain.set(domain, list);
  }
  // Domain.OR of (alias_name in names & alias_domain_id = domain): a domain with no name gives `alias_name in []`
  const parts: Domain[] = [...byDomain].map(([domain, list]) => and([cond('alias_name', 'in', list), cond('alias_domain_id', '=', domain)]));
  if (!parts.length) return;
  let domain = or(parts);
  if (selfIds.length) domain = and([domain, cond('id', 'not in', [...selfIds])]);
  const [existing] = await env.model('mail.alias').search(domain, { limit: 1 });
  if (existing === undefined) return;
  const row = (await env.sudo().model('mail.alias').read([existing], ['alias_model_id', 'alias_parent_model_id', 'alias_parent_thread_id'], ''))[0]!;
  const m2o = (v: unknown): number | false => (typeof v === 'number' ? v : Array.isArray(v) ? (v[0] as number) : false);
  const modelId = m2o(row['alias_model_id']), parentModelId = m2o(row['alias_parent_model_id']);
  const parentThread = typeof row['alias_parent_thread_id'] === 'number' ? row['alias_parent_thread_id'] : 0;
  const modelName = async (id: number | false): Promise<string> => {
    if (!id) return '';
    const r = (await env.model('ir.model').read([id], ['name', 'model'], ''))[0];
    return String(r?.['name'] ?? '');
  };
  const matchingName = (await env.model('mail.alias').displayName([existing])).get(existing) ?? '';
  const ids = selfIds.map(String);
  let begin: string;
  if (parentModelId && parentThread) {
    const parentModel = String((await env.sudo().model('ir.model').read([parentModelId], ['model'], ''))[0]?.['model'] ?? '');
    if (!env.reg.models.has(parentModel)) throw new NotPorted(`mail.alias _check_unique with parent model ${parentModel}`);
    const parentName = (await env.sudo().model(parentModel).displayName([parentThread])).get(parentThread) ?? '';
    begin = translate(env, 'Alias %(matching_name)s (%(current_id)s) is already linked with %(alias_model_name)s (%(matching_id)s) and used by the %(parent_name)s %(parent_model_name)s.', 'mail')
      .replace('%(matching_name)s', matchingName)
      .replace('%(current_id)s', ids.length ? formatList(env, ids) : translate(env, 'your alias', 'mail'))
      .replace('%(alias_model_name)s', await modelName(modelId))
      .replace('%(matching_id)s', String(existing))
      .replace('%(parent_name)s', parentName)
      .replace('%(parent_model_name)s', await modelName(parentModelId));
  } else {
    begin = translate(env, 'Alias %(matching_name)s (%(current_id)s) is already linked with %(alias_model_name)s (%(matching_id)s).', 'mail')
      .replace('%(matching_name)s', matchingName)
      .replace('%(current_id)s', ids.length ? formatList(env, ids) : translate(env, 'new', 'mail'))
      .replace('%(alias_model_name)s', await modelName(modelId))
      .replace('%(matching_id)s', String(existing));
  }
  throw new UserError(`${begin} ${translate(env, 'Choose another value or change it on the other document.', 'mail')}`);
}

/** The values of a write the mixin answers alone (only writable alias fields): super() is not called (:126-127), so
 *  neither are BaseModel.write's checks; for a user without write access nothing is written (an alias it would create
 *  is linked by a full write, :122-124, which checks). */
export function aliasOnlyWrite(vals: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(vals);
  return keys.length > 0 && keys.every((k) => ALIAS_WRITEABLE_FIELDS.includes(k));
}

/**
 * mail_alias_mixin_optional.py:108-141 `write`: a missing alias is created when a name is given; the writable alias
 * fields (ALIAS_WRITEABLE_FIELDS) go on the aliases in sudo, the others to `super()` (`next`), which is not called
 * when nothing else is written. `creationValues` is the model's `_alias_get_creation_values` for a record. The
 * company's alias domain synchronisation (:128-133) is not here: the guard refuses `company_id`
 * (src/orm/override_status.ts).
 */
export async function aliasMixinWrite(env: Environment, model: string, ids: readonly number[], vals: Record<string, unknown>,
  next: WriteFn, creationValues: (env: Environment, id: number) => Promise<Record<string, unknown>>): Promise<void> {
  const table = env.reg.model(model).table;
  const aliasOf = async (): Promise<Map<number, number | null>> => new Map((await env.cr.query<{ id: number; a: number | null }>(
    `SELECT id, alias_id AS a FROM "${table}" WHERE id = ANY($1::int[])`, [[...ids]])).rows.map((r) => [r.id, r.a]));
  if (vals['alias_name']) {
    // :113-124 create the missing aliases (sudo), then link each to its record
    const cur = await aliasOf();
    const missing = ids.filter((id) => (cur.get(id) ?? null) === null);
    if (missing.length) {
      const valsList: Record<string, unknown>[] = [];
      for (const id of missing) valsList.push({ ...(await creationValues(env, id)), alias_name: sanitizeAliasName(vals['alias_name']) });
      const aliases = await create(env.sudo(), 'mail.alias', valsList);
      for (let i = 0; i < missing.length; i++) await write(env, model, [missing[i]!], { alias_id: aliases[i] });
    }
  }
  const aliasVals: Record<string, unknown> = {}, recordVals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vals)) (ALIAS_WRITEABLE_FIELDS.includes(k) ? aliasVals : recordVals)[k] = v;
  if (Object.keys(recordVals).length) await next(env, ids, recordVals);
  if (Object.keys(aliasVals).length && (Object.keys(recordVals).length || await hasModelAccess(env, model, 'write'))) {
    // `self.mapped('alias_id')`: the aliases in the order of the records, without duplicates
    const cur = await aliasOf();
    const aliases: number[] = [];
    for (const id of ids) {
      const a = cur.get(id) ?? null;
      if (a !== null && !aliases.includes(a)) aliases.push(a);
    }
    if (aliases.length) await write(env.sudo(), 'mail.alias', aliases, aliasVals);
  }
}

export async function irModelId(env: Environment, model: string): Promise<number> {
  const id = (await env.cr.query<{ id: number }>('SELECT id FROM ir_model WHERE model = $1', [model])).rows[0]?.id;
  if (id === undefined) throw new NotPorted(`ir.model of ${model}`);
  return id;
}

/** mail_alias_mixin_optional.py:186-196 `_alias_get_creation_values` of the mixin itself. */
export async function baseAliasCreationValues(env: Environment, model: string, id: number | null): Promise<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    alias_parent_thread_id: id ?? false,
    alias_parent_model_id: await irModelId(env, model),
  };
  if ('default_alias_domain_id' in env.context) values['alias_domain_id'] = env.context['default_alias_domain_id'];
  return values;
}

/** mail_alias_mixin_optional.py:99-103: each created record with an alias writes its creation values on it (sudo). */
export async function writeAliasCreationValues(env: Environment, model: string, ids: readonly number[],
  values: (id: number) => Promise<Record<string, unknown>>): Promise<void> {
  const table = env.reg.model(model).table;
  for (const id of ids) {
    const alias = (await env.cr.query<{ a: number | null }>(`SELECT alias_id AS a FROM "${table}" WHERE id = $1`, [id])).rows[0]?.a ?? null;
    if (alias === null) continue;
    await write(env.sudo(), 'mail.alias', [alias], await values(id));
  }
}

const PENDING_ALIASES = new Map<string, number[]>();

/**
 * mail.alias.mixin unlink (mail_alias_mixin_optional.py:143-148): the records' aliases are deleted after them, as superuser
 * (an alias still used elsewhere fails on its foreign key as in Odoo).
 */
export function registerAliasMixinUnlink(model: string): void {
  const key = (env: Environment, ids: readonly number[]): string => `${env.cr.db}|${model}|${[...ids].join(',')}`;
  registerHooks(model, {
    write: [{
      beforeUnlink: async (env, ids) => {
        const table = env.reg.model(model).table;
        const rows = (await env.cr.query<{ a: number | null }>(`SELECT alias_id AS a FROM "${table}" WHERE id = ANY($1::int[]) ORDER BY id`, [[...ids]])).rows;
        PENDING_ALIASES.set(key(env, ids), [...new Set(rows.map((r) => r.a).filter((a): a is number => a !== null))]);
      },
      afterUnlink: async (env, ids) => {
        const k = key(env, ids);
        const aliases = PENDING_ALIASES.get(k) ?? [];
        PENDING_ALIASES.delete(k);
        if (aliases.length) await unlink(env.sudo(), 'mail.alias', aliases);
      },
    }],
  });
}
