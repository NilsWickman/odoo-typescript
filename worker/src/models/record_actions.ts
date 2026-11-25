/**
 * Two small methods the web client calls in daily work:
 * - `get_record_default_action` (base/models/ir_ui_view.py:3289-3305, on every model): the many2one link in a form
 *   (web/static/src/views/fields/many2one/many2one.js:251-258) opens the record with the action it returns.
 * - `res.config.settings.is_root_company` (base_setup/models/res_config_settings.py:13, :131-133), computed when the
 *   Settings page opens (onchange on a new record).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { isInstalled } from "../http/modules";
import { registerRecordCompute } from "../orm/recompute";

// The overrides of get_formview_id / get_record_default_action in Odoo 20 Community are all hr's (hr_employee.py:1590,
// hr_version.py:394, hr_department.py, res_users.py:354, hr_recruitment_survey survey_survey.py): refused when hr is
// installed, so the base answer is only given where it is Odoo's.
registerMethod("*", "get_record_default_action", async (env, ids, args, kwargs, model) => {
  if (await isInstalled(env.cr, "hr")) throw new NotPorted("get_record_default_action with hr installed (hr's overrides)");
  const accessUid = args[0] ?? kwargs["access_uid"] ?? null;
  if (accessUid !== null && accessUid !== undefined && accessUid !== false && typeof accessUid !== "number") throw new NotPorted("get_record_default_action access_uid value");
  const list = ids ?? [];
  // `self.id` of a recordset: False when empty, a singleton's id, else ValueError (ensure_one)
  if (list.length > 1) throw new NotPorted("get_record_default_action on several records (Expected singleton)");
  return {
    type: "ir.actions.act_window",
    res_model: model,
    // :3297 `self.sudo().get_formview_id(access_uid=...)`: base's is False (:3279-3287)
    views: [[false, "form"]],
    target: "current",
    res_id: list[0] ?? false,
    context: { ...env.context },
  };
}, { apiModel: false, readonly: true });

registerRecordCompute("res.config.settings", {
  // base_setup res_config_settings.py:131-133: `not record.company_id.parent_id`
  is_root_company: async (_env, rec) => {
    const company = await rec.rel("company_id");
    return !(company && (await company.get("parent_id")));
  },
});
