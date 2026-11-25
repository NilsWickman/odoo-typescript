/**
 * Methods the data files of the installed modules call through `<function>` (src/modules/convert.ts
 * registerDataFunction) that are not in the call_kw table: l10n_se/demo/demo_company.xml (ACCEPTANCE A1).
 */
import { registerDataFunction } from "../modules/convert";
import { NotPorted } from "../errors";
import { write } from "../orm/write";
import { tryLoadingHooked } from "./chart_load";

// base res_company.py:251-255 `_onchange_country_id` called on stored records: an assignment, i.e. a write
registerDataFunction("res.company", "_onchange_country_id", {
  apiModel: false,
  fn: async (env, ids) => {
    for (const id of ids) {
      const r = (await env.cr.query<{ currency_id: number | null; current: number | null }>(
        `SELECT k.currency_id, c.currency_id AS current FROM res_company c JOIN res_partner p ON p.id = c.partner_id
           JOIN res_country k ON k.id = p.country_id WHERE c.id = $1`, [id])).rows[0];
      // Field.__set__ writes only the records whose value differs (fields.py `_filter_not_equal`)
      if (r && r.currency_id !== r.current) await write(env, "res.company", [id], { currency_id: r.currency_id ?? false });
    }
  },
});

registerDataFunction("res.users", "write", {
  apiModel: false,
  fn: async (env, ids, args) => write(env, "res.users", ids, args[0] as Record<string, unknown>),
});

// account chart_template.py:151 `try_loading(template_code, company, install_demo=False, force_create=True)`
registerDataFunction("account.chart.template", "try_loading", {
  apiModel: false,
  fn: async (env, _ids, args, kwargs) => {
    const [code, company, installDemo = kwargs["install_demo"] ?? false, forceCreate = kwargs["force_create"] ?? true] = args;
    if (forceCreate !== true) throw new NotPorted("try_loading with force_create=False");
    await tryLoadingHooked(env, typeof code === "string" ? code : null, Number(company), installDemo === true);
  },
});

// base ir_default.py:79-137 `set(model_name, field_name, value, user_id=False, company_id=False, condition=False)` for
// every user and company (purchase_requisition_stock_data.xml: the default warehouse of purchase.requisition); a user,
// a company or a condition refuses
registerDataFunction("ir.default", "set", {
  apiModel: true,
  fn: async (env, _ids, args, kwargs) => {
    const [model, field, value, userId = kwargs["user_id"] ?? false, companyId = kwargs["company_id"] ?? false, condition = kwargs["condition"] ?? false] = args;
    if (userId !== false || companyId !== false || condition !== false) throw new NotPorted("ir.default.set for a user, a company or a condition from a data file");
    if (typeof model !== "string" || typeof field !== "string") throw new NotPorted("ir.default.set without a model and a field name");
    const { irDefaultSet } = await import("./company_create");
    await irDefaultSet(env, model, field, value, false);
    return true;
  },
});
