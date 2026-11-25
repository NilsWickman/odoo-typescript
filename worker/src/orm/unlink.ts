/**
 * `BaseModel.unlink` (odoo/odoo/orm/models.py:3658-3800) and the web client's `web_unlink`
 * (odoo/addons/web/models/models.py:265-317).
 */
import { MissingError, NotPorted, OdooError } from "../errors";
import { checkModelAccess } from "./access";
import { hooksOf } from "./hooks";
import { ModelImpl } from "./model";
import { invalidationPoint, RecomputeQueue } from "./recompute";
import { ident, runSql, sql } from "./sql";
import type { Environment, ModelDef } from "./types";
import { overridesOf } from "./write";
import { markWritten } from "./written_fields";

/** The public `unlink()`: mail.thread hooks, `@api.ondelete` methods, the ORM core. */
export async function unlink(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const own = overridesOf(model).unlink;
  if (own) await own(env, ids, (env2, ids2) => unlinkBase(env2, model, ids2));
  else await unlinkBase(env, model, ids);
  await invalidationPoint(env, model, "unlink", "after");
}

async function unlinkBase(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const def = env.reg.model(model);
  const hooks = hooksOf(model).write ?? [];
  // models.py:3666 check_access('unlink') comes first in BaseModel.unlink; overrides above it (mail_thread.py:424)
  // run their side effects before, but every error rolls the request back, so checking first is equivalent.
  await checkUnlinkAccess(env, def, ids);
  const ondelete = overridesOf(model).beforeUnlink;
  try {
    for (const h of hooks) if (h.beforeUnlink) await h.beforeUnlink(env, ids);
  } catch (e) {
    // a mail.thread step that refuses (mail_thread.py:424-438 runs before super().unlink()): in Odoo it would have
    // succeeded and the `@api.ondelete` checks after it decide; their error rolls everything back, so it is the answer
    if (e instanceof NotPorted && ondelete) await ondelete(env, ids);
    throw e;
  }
  if (ondelete) await ondelete(env, ids);
  await unlinkCore(env, def, ids);
  await unlinkActivities(env, def, ids);
  for (const h of hooks) if (h.afterUnlink) await h.afterUnlink(env, ids);
}

/**
 * addons/mail/models/models.py:48-57 (every model, the class right above BaseModel): after the delete, the activities of
 * the deleted records (`res_model`, `res_id`) are deleted as superuser; not for transient models. mail.activity's own
 * unlink (mail_activity.py:408) only adds the `mail.activity/updated` bus counter of overdue activities (not sent,
 * as in src/mail/write_hooks.ts threadAfterUnlink).
 */
async function unlinkActivities(env: Environment, def: ModelDef, ids: readonly number[]): Promise<void> {
  if (def.transient || def.abstract || !env.reg.models.has("mail.activity") || def.name === "mail.activity") return;
  await env.cr.query("DELETE FROM mail_activity WHERE res_model = $1 AND res_id = ANY($2::int[])", [def.name, [...ids]]);
}

/**
 * Models whose installed `unlink` overrides read the records before `super().unlink()` reaches check_access: a
 * deleted record raises MissingError (fields.py:1886) before any AccessError. mail_alias_mixin_optional.py:145
 * (`self.mapped('alias_id')`, crm.team / project.project / account.journal), project_project.py:807,
 * account_journal.py:736, sale account_move.py:37, account_bank_statement_line.py:430-438, calendar res_users.py:89.
 */
const READS_BEFORE_SUPER = new Set(["crm.team", "project.project", "account.journal", "account.move", "account.bank.statement.line", "res.users"]);

export async function checkUnlinkAccess(env: Environment, def: ModelDef, ids: readonly number[]): Promise<void> {
  if (env.su) return;
  if (READS_BEFORE_SUPER.has(def.name) || (def.fields.has("alias_id") && def.fields.has("alias_email"))) {
    const rows = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[])`);
    if (rows.length < new Set(ids).size) {
      const found = new Set(rows.map((r) => r.id));
      const missing = [...new Set(ids)].filter((id) => !found.has(id));
      if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated MissingError (${env.lang})`);
      throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${def.name}(${missing[0]},), User: ${env.uid})`);
    }
  }
  await checkModelAccess(env, def, "unlink");
  // models.py:3498-3502 has_access: an unrestricted domain checks nothing (missing records pass and DELETE nothing);
  // otherwise filtered_domain reads the records and a deleted one raises MissingError (fields.py:1886)
  const domain = await new ModelImpl(env, def).accessDomain("unlink");
  if (domain === null || domain.kind === "true") return;
  const rows = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[])`);
  if (rows.length < new Set(ids).size) {
    const found = new Set(rows.map((r) => r.id));
    const missing = [...new Set(ids)].filter((id) => !found.has(id));
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated MissingError (${env.lang})`);
    throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${def.name}(${missing[0]},), User: ${env.uid})`);
  }
  await new ModelImpl(env, def).checkAccess(ids, "unlink");
}

/** models.py:3680-3790 after the ondelete methods. */
async function unlinkCore(env: Environment, def: ModelDef, ids: readonly number[]): Promise<void> {
  // models.py:3686 modified(before=True): records depending on the deleted ones are recomputed afterwards
  const queue = new RecomputeQueue(env);
  await queue.modified(def.name, ids, def.fields.keys());
  // ir.default.discard_records (ir_default.py:203) and company-dependent many2one references (models.py:3711)
  const defaults = await runSql<{ id: number }>(env, sql`SELECT d.id FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
    WHERE f.ttype = 'many2one' AND f.relation = ${def.name} AND d.json_value = ANY(${ids.map((id) => JSON.stringify(id))}::text[])`);
  if (defaults.length) throw new NotPorted(`unlink of records used as ir.default (${def.name})`);
  for (const m of env.reg.models.values()) {
    for (const f of m.fields.values()) {
      if (f.type === "many2one" && f.companyDependent && f.relation === def.name && f.store) {
        // models.py:3741-3785: jsonb company-dependent many2one, restrict or set null per company value
        // (the `@? jsonpath` filter of Odoo, as an EXISTS over the jsonb values)
        const refs = sql`EXISTS (SELECT 1 FROM jsonb_each_text(${ident(f.name)}) j WHERE j.value::int4 = ANY(${[...ids]}::int4[]))`;
        if (f.ondelete === "restrict" && !env.context["force_delete"]) {
          const used = await runSql<{ id: number }>(env, sql`SELECT id FROM ${ident(m.table)} WHERE ${ident(f.name)} IS NOT NULL AND ${refs} LIMIT 1`);
          if (used.length) throw new NotPorted(`unlink restricted by company-dependent ${m.name}.${f.name} (UserError)`);
        } else {
          // a raw query in Odoo too (execute_query): no field of it reaches a Store version's written fields
          markWritten(env, m.name, [], []);
          await runSql(env, sql`UPDATE ${ident(m.table)} SET ${ident(f.name)} = (SELECT jsonb_object_agg(key, CASE WHEN value::int4 = ANY(${[...ids]}::int4[]) THEN NULL ELSE value::int4 END) FROM jsonb_each_text(${ident(f.name)}))
            WHERE ${ident(f.name)} IS NOT NULL AND ${refs}`);
        }
      }
    }
  }
  // models.py:3720-3727 the records' attachments (by SQL: the attachments' search hides those of deleted records)
  const attachments = (await runSql<{ id: number }>(env, sql`SELECT id FROM ir_attachment WHERE res_model = ${def.name} AND res_id = ANY(${[...ids]}::int[]) ORDER BY id`)).map((r) => r.id);
  await runSql(env, sql`DELETE FROM ${ident(def.table)} WHERE id = ANY(${[...ids]}::int[])`);
  // models.py:3700 ir.model.data of the records
  await runSql(env, sql`DELETE FROM ir_model_data WHERE model = ${def.name} AND res_id = ANY(${[...ids]}::int[])`);
  // models.py:3795-3796 then the attachments, as superuser
  await unlinkAttachments(env, attachments);
  await queue.run();
}

/**
 * `self.env['ir.attachment'].sudo().browse(ids).unlink()` (ir_attachment.py:908-918): the overrides of the template's
 * ir.attachment unlink are checked by the guard (account's, for journal entries, refuse), then the ORM's unlink.
 * `_file_delete` only marks the stored files for the filestore's garbage collection (`_mark_for_gc`, a file in the
 * filestore's checklist): nothing in the database, nothing to do in this port (as src/controllers/assets.ts).
 */
export async function unlinkAttachments(env: Environment, ids: readonly number[]): Promise<void> {
  if (!ids.length) return;
  const su = env.sudo();
  const { guardOverride } = await import("./override_guard");
  await guardOverride(su, "ir.attachment", "unlink", ids, []);
  await unlink(su, "ir.attachment", ids);
}

/** odoo/addons/web/models/models.py:35 UnlinkBlockedError (a ValidationError with a context payload). */
export class UnlinkBlockedError extends OdooError {
  constructor(message: string, context: Record<string, unknown>) {
    super("odoo.addons.web.models.models.UnlinkBlockedError", message, [message], { context });
  }
}

function isFkViolation(e: unknown): e is { code: string; table?: string } {
  return typeof e === "object" && e !== null && "code" in e && ["23503", "23001"].includes(String((e as { code: unknown }).code));
}

let savepointSeq = 0;

/** web/models/models.py:265 web_unlink: unlink in a savepoint; an FK violation becomes UnlinkBlockedError. */
export async function webUnlink(env: Environment, model: string, ids: readonly number[]): Promise<true> {
  const sp = `wr_unlink_${++savepointSeq}`;
  await env.cr.query(`SAVEPOINT ${sp}`);
  try {
    await unlink(env, model, ids);
    await env.cr.query(`RELEASE SAVEPOINT ${sp}`);
    return true;
  } catch (e) {
    await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    if (!isFkViolation(e)) throw e;
    // models.py:288-317: the blocking model, then record-by-record retries to find the blocked ids
    const table = (e as { table?: string }).table;
    const blocking = [...env.reg.models.values()].find((m) => m.table === table && !m.abstract);
    if (!blocking) throw e;
    const blocked: number[] = [];
    const sp2 = `wr_unlink_${++savepointSeq}`;
    await env.cr.query(`SAVEPOINT ${sp2}`);
    for (const id of ids) {
      try {
        await unlink(env, model, [id]);
      } catch (inner) {
        if (!isFkViolation(inner)) { await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp2}`); throw inner; }
        blocked.push(id);
      } finally {
        await env.cr.query(`ROLLBACK TO SAVEPOINT ${sp2}`);
      }
    }
    if (!blocked.length) throw e;
    if (env.lang && env.lang !== "en_US") throw new NotPorted(`translated UnlinkBlockedError (${env.lang})`);
    const name = (await env.cr.query<{ name: string | null }>("SELECT name->>'en_US' AS name FROM ir_model WHERE model = $1", [blocking.name])).rows[0]?.name || blocking.name;
    throw new UnlinkBlockedError(`The operation cannot be completed: this record is used by ${name}`, {
      archivable: !!env.reg.model(model).activeName, model_name: name, res_model: model, res_ids: [...ids], blocked_ids: blocked,
    });
  }
}
