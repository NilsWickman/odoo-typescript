/**
 * `mail.template` create and write (mail/models/mail_template.py:259-272 with mail_render_mixin.py:109-137), rådet runda 13,
 * åtgärd 5: before, every write of a template refused at the guard (src/orm/override_guard.ts), also its translation
 * from the dialog. In Odoo's order:
 *   1. `_check_abstract_models([vals])` (:210-216): a `model_id` of an abstract model is a ValidationError;
 *   2. the write; then MailRenderMixin's `_check_access_right_dynamic_template` for the env's and the written dicts'
 *      languages (:330-336): a user outside mail.group_mail_template_editor may not write a template with unsafe
 *      expressions; `_has_unsafe_expression` is not ported, so such a user refuses;
 *   3. `_check_can_be_rendered(fnames)` (:218-243): every written dynamic field (all of them when the model changes) is
 *      rendered on the model's first record; a rendering error is Odoo's "Oops! ..." ValidationError with the Python
 *      exception's text, which the port cannot give: refused;
 *   4. `_fix_attachment_ownership` (:205-208): the template's attachments are written to it.
 */
import { NotPorted, ValidationError } from "../errors";
import { TRUE } from "../orm/domain";
import { hasGroup } from "../orm/env";
import type { Environment } from "../orm/types";
import { registerOverrides, write } from "../orm/write";
import { renderTemplateField, type TemplateField } from "../qweb/mail_render";
import { translate } from "./util";
import { loadingFromAddons } from "../modules/install";

const DYNAMIC: readonly TemplateField[] = ["body_html", "email_cc", "email_from", "email_to", "lang", "partner_cc", "partner_to", "reply_to", "scheduled_date", "subject"];

/** :210-216 `_check_abstract_models`. */
async function checkAbstractModels(env: Environment, valsList: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
  for (const vals of valsList) {
    const modelId = vals["model_id"];
    if (!modelId) continue;
    const m = (await env.cr.query<{ model: string }>("SELECT model FROM ir_model WHERE id = $1", [modelId])).rows[0]?.model;
    if (m && env.reg.models.get(m)?.abstract) throw new ValidationError(translate(env, "You may not define a template on an abstract model: %s", "mail").replace("%s", m));
  }
}

/** mail_render_mixin.py:109-137 `_check_access_right_dynamic_template` (`_unrestricted_rendering` is True on mail.template). */
async function checkEditor(env: Environment, what: string): Promise<void> {
  if (!env.su && !(await hasGroup(env, "mail.group_mail_template_editor"))) {
    throw new NotPorted(`mail.template ${what} by a user outside the template editors (_has_unsafe_expression)`);
  }
}

registerOverrides("mail.template", {
  // :259-265: the abstract models, the create (with the editor check of mail_render_mixin.py:109-123), every dynamic
  // field rendered on the model's first record, the attachments' ownership
  create: async (env, valsList, next) => {
    await checkAbstractModels(env, valsList);
    // template_reset_mixin.py:28-37: a template a module's data file creates remembers that file (`template_fs`, the
    // module and the path in it, as `get_resource_from_path` gives them from `install_filename`); lunch's
    // lunch_order_mail_supplier
    const file = env.context["install_filename"];
    if (typeof file === "string" && loadingFromAddons(env)) {
      for (const vals of valsList) if (!("template_fs" in vals)) vals["template_fs"] = file;
    }
    const ids = await next(env, valsList);
    await checkEditor(env, "create");
    await checkCanBeRendered(env, ids, DYNAMIC);
    await fixAttachmentOwnership(env, ids);
    return ids;
  },
  write: async (env, ids, vals, next) => {
    // 1. :210-216
    await checkAbstractModels(env, [vals]);
    await next(env, ids, vals);
    // 2. mail_render_mixin.py:125-137 (`_unrestricted_rendering` is True on mail.template)
    await checkEditor(env, "write");
    // 3. :218-243, `fnames & dynamic_fnames` unless the model changes
    await checkCanBeRendered(env, ids, "model" in vals || "model_id" in vals ? DYNAMIC : DYNAMIC.filter((f) => f in vals));
    // 4. :205-208
    await fixAttachmentOwnership(env, ids);
  },
});

/** :218-243 `_check_can_be_rendered(fnames)`: the fields rendered on the model's first record. */
async function checkCanBeRendered(env: Environment, ids: readonly number[], fnames: readonly TemplateField[]): Promise<void> {
  for (const id of ids) {
    const model = (await env.cr.query<{ model: string | null }>("SELECT model FROM mail_template WHERE id = $1", [id])).rows[0]?.model;
    if (!model) return; // `return` in Odoo: the other templates are not checked either
    const [record] = await env.model(model).search(TRUE, { limit: 1 });
    if (record === undefined) return;
    for (const f of fnames) {
      try {
        await renderTemplateField(env, id, f, record, null, false);
      } catch (e) {
        if (e instanceof NotPorted) throw e;
        throw new NotPorted(`the mail.template rendering error of ${f} (Odoo's ValidationError carries the Python exception: ${e instanceof Error ? e.message : String(e)})`);
      }
    }
  }
}

/** :205-208 `_fix_attachment_ownership`. */
async function fixAttachmentOwnership(env: Environment, ids: readonly number[]): Promise<void> {
  for (const id of ids) {
    const att = (await env.cr.query<{ id: number }>(
      "SELECT r.attachment_id AS id FROM email_template_attachment_rel r WHERE r.email_template_id = $1 ORDER BY r.attachment_id", [id])).rows.map((r) => r.id);
    if (att.length) await write(env, "ir.attachment", att, { res_model: "mail.template", res_id: id });
  }
}
