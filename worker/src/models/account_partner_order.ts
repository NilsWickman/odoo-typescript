/**
 * account/models/partner.py:381-387: res.partner `_order` is a property; with `res_partner_search_mode` customer or
 * supplier in the context the default order starts with `<mode>_rank DESC`. Explicit orders are unchanged.
 */
import { registerHooks } from "../orm/hooks";

registerHooks("res.partner", {
  searchFetch: async (env, domain, opts, next) => {
    const mode = env.context["res_partner_search_mode"];
    const def = env.reg.model("res.partner");
    if ((mode !== "customer" && mode !== "supplier") || opts.order || !def.fields.has(`${mode}_rank`)) return next(domain, opts);
    return next(domain, { ...opts, order: def.order ? `${mode}_rank DESC, ${def.order}` : `${mode}_rank DESC` });
  },
});
