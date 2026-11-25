/**
 * Python behaviour of the payment.* models the API corpus reaches (odoo/addons/payment/models/ and the installed
 * account_payment overrides, poc_erp). Rows in worker/COMPUTED.md.
 */
import { NotPorted } from "../errors";
import { and, cond } from "../orm/domain";
import { relatedSelections } from "./account_computes";
import { defineComputes } from "./tail_util";

relatedSelections("payment.provider", ["module_state"]);

defineComputes("payment.provider", {
  // account_payment/models/payment_provider.py:102-119 `_compute_journal_id` / `_get_journal_domain`
  journal_id: async (env, rec) => {
    const lines = await env.model("account.payment.method.line").search(
      and([cond("payment_provider_id", "=", rec.origin ?? false), cond("journal_id", "!=", false)]), { limit: 1 });
    if (lines.length) {
      const r = await env.model("account.payment.method.line").read(lines, ["journal_id"], "");
      return r[0]?.["journal_id"] ?? false;
    }
    const company = await rec.get("company_id");
    const journals = await env.model("account.journal").search(and([cond("company_id", "=", company || false), cond("type", "=", "bank")]), { limit: 1 });
    // :115-116: an existing provider also gets its payment method line created (a write during the read)
    if (rec.id !== null) {
      // :37-44 `_ensure_payment_method_line` stops without a payment method of the provider's code
      const method = await env.model("account.payment.method").search(cond("code", "=", (await rec.get("code")) as string), { limit: 1 });
      if (method.length) throw new NotPorted("payment.provider journal_id without a method line (_ensure_payment_method_line writes)");
    }
    return journals[0] ?? false;
  },
  // payment_provider.py:350-364 `_compute_available_currency_ids` (stored): empty when the provider supports every
  // currency, which the base `_get_supported_currencies` (:366-378) does. A provider module overriding that private
  // method has no hook (private_hooks.json): a site with it is not built (compiler/oc/build.py refuses the key), so
  // every provider here supports all of them (payment_demo does not override it)
  available_currency_ids: async () => [],
});
