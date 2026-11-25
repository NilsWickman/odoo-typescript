# mail WriteHooks: the call shape the write core must honour

Registered by `src/mail/write_hooks.ts` (imported by `src/mail/routes.ts`) through `registerHooks(model, {write: [...]})`
for the mail.thread models of poc_corpus (`MAIL_THREAD_MODELS`: discuss.channel, iap.account, ir.access,
ir.actions.server, ir.cron, mail.blacklist, phone.blacklist, res.partner, res.users). `discuss.channel` refuses
(NotPorted) on create/write and `res.users` on create and on writes of group_ids, login, password, email or
notification_type: their own mail overrides are not ported. The other mail.thread models
of poc_erp (`ERP_THREADS`) get the same generic hooks driven by their `tracking` field metadata, with the
per-model `RULES` (create contexts, `_track_log_get_default_subtype` fields that refuse); project.task refuses and
crm.lead has its own (src/models/crm_lead_mail.ts). A model with `ModelDef.isMailThread` in neither list gets no mail side effects: WR should refuse
writes on it (`isPortedMailThread(model)`).

Assumed calls (the integration check `src/mail/write_hooks.check.ts` makes exactly these):

| Hook | When the core calls it | Arguments |
|---|---|---|
| `beforeCreate(env, valsList)` | not used by mail | |
| `afterCreate(env, ids, valsList)` | after the rows of one `create` batch are INSERTed and flushed (stored computes, x2many and inverse writes done), inside the request transaction, before the core returns | `env` = the caller's env (its context: `mail_create_nolog`, `mail_create_nosubscribe`, `tracking_disable`, `default_*`), `ids` in creation order, `valsList` the create values as given (before defaults) |
| `beforeWrite(env, ids, vals)` | before any column of `ids` is UPDATEd by `write`, **including writes the core performs itself** (children synced by `_commercial_sync_*`/`_fields_sync`, recompute of stored computed fields: call it with the recomputed ids before storing new values) | |
| `afterWrite(env, ids, vals, old)` | after the UPDATE and every nested write/recompute it triggered are flushed; calls must nest like a stack per model (each beforeWrite has exactly one afterWrite, the nested ones close first) | `old` is not used: mail snapshots the tracked fields itself in beforeWrite |
| `beforeUnlink(env, ids)` | before the DELETE | |
| `afterUnlink(env, ids)` | after the DELETE of the rows | |

What they do (Odoo source in odoo/addons/mail/models/):
- afterCreate: `mail_thread.py:346 create`: follower for the current user unless `mail_create_nosubscribe`
  (res.partner defaults it to True, `res_partner.py:68`); `_message_auto_subscribe` (refuses for a truthy tracked
  `user_id` and parent-subtype relations); the creation message "<model> created" via `_message_log_batch`
  unless `mail_create_nolog`; `_track_discard`: records created in the transaction are never tracked again in it.
- beforeWrite/afterWrite: `mail_track_mixin.py:29,76` snapshot of all tracked fields (first snapshot of a record
  wins); when the outermost write of that model returns, `_track_finalize`/`_track_log`: one `tracking` message per
  changed record with the `mail.mail_tracking_template` body, labels from `fields_get` in the env language.
  Difference to Odoo: Odoo finalizes at precommit (once per transaction); the port finalizes at the outermost
  `afterWrite` of the model, so two separate top-level writes of one record in one request log two messages.
- beforeUnlink/afterUnlink: `mail_thread.py:424`: messages, followers and scheduled messages of the records;
  `models.py:48` activities of deleted records refuse (their unlink sends bus notifications, not ported).

All rows are written with SQL in the request cursor (no ORM create of mail.message), so no hook re-enters the core.

## Calls outside the ORM core (stream H)

- First login (`base/models/res_users.py:857 _login`): `user.tz = browser tz` is a res.users write, so call
  `beforeWrite(env_user, [uid], {tz})` before the tz UPDATE and `afterWrite(env_user, [uid], {tz}, new Map())`
  after the `res.users.log` INSERT of `_update_last_login`: Odoo snapshots `state` ("Invited") before the log
  exists and logs "Invited → Confirmed (Status)" at precommit (S3 and C3 db_diff, message by the user, create_uid
  = the user). `env_user` is the user's environment (`with_user(user).sudo()`).



## mail.activity

`src/mail/activity.ts` registers `afterCreate`/`afterWrite` on `mail.activity` (mail_activity.py:324, :362): the
responsible user follows the document (`message_subscribe`); assigning another user refuses (the assignment
notification and email of `action_notify` are not ported). `src/models/mail_activity_write.ts` registers its Python
defaults (`registerDefaults`) and stored computes (`registerRecordCompute`: date_done, res_name, phone,
date_deadline, note, summary, user_id, role_id) for the core. Creating an activity through the core needs
many2one_reference values (`res_id`) in `convert.ts` (currently NotPorted there).
