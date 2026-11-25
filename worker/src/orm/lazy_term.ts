/**
 * A lazy translation (`_lt(...)`, odoo/tools/translate.py:1163-1205 LazyGettext) that compiled code put in a context
 * (compiler/runtime/records.ts `with_context`): lunch.supplier `_send_auto_email` gives the mail layout
 * `email_notification_subtitles=[_lt("Lunch Order")]`. The hand port reads it where Odoo calls `str()` on it
 * (src/mail/template_send.ts renderEncapsulate). Its arguments, when it has any, are not carried: compiled code refuses
 * such a term in a context.
 */
export class LazyTerm {
  constructor(readonly source: string, readonly module: string) {}
}
