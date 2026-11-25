/**
 * The `@api.onchange` methods of the invoice form (account.move and account.move.line, account_move.py:2728-2915,
 * :4626-4676, account_move_line.py:1753-1820, purchase account_invoice.py:39-144). The branches the map's recorded
 * calls reach are ported; a branch that needs more (sequence formats, copying lines, quick encoding, journal
 * search) refuses inside the method.
 */
import { NotPorted, ValidationError } from "../errors";
import { DbRec, NewRec, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { generatedOnchanges } from "../orm/onchange_methods";
import { templateOf } from "../orm/template";
import { withCompany } from "./tail_util";
import { translate } from "./util";

const idOf = (v: unknown): number | null => (typeof v === "number" ? v : v instanceof NewRec ? (v.origin ?? null) : null);
const isNew = (v: unknown): boolean => v instanceof NewRec && v.origin === null;

/** account_move.py:7288-7309 `is_invoice(include_receipts)`. */
async function isInvoice(rec: Rec, receipts: boolean): Promise<boolean> {
  const t = String(await rec.get("move_type"));
  return ["out_invoice", "out_refund", "in_invoice", "in_refund", ...(receipts ? ["out_receipt", "in_receipt"] : [])].includes(t);
}

/** `line_ids + invoice_line_ids` (a recordset sum keeps duplicates; `|` does not). */
async function moveLines(rec: NewRec, union: boolean): Promise<Rec[]> {
  const all = [...await rec.rels("line_ids"), ...await rec.rels("invoice_line_ids")];
  if (!union) return all;
  const seen = new Set<unknown>();
  return all.filter((l) => { const k = l instanceof NewRec ? (l.origin ?? l) : l.id; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * account_move_line.py:4105-4112 `_conditional_add_to_compute` on lines: the field is recomputed on the lines that
 * match and are not protected. A stored line read from the database cannot be recomputed in the form: it refuses.
 */
async function lineAddToCompute(lines: readonly Rec[], fname: string, condition: (l: Rec) => Promise<boolean>, what: string): Promise<void> {
  for (const line of lines) {
    if (line instanceof NewRec && line.protectedFields.has(fname)) continue;
    if (!(await condition(line))) continue;
    if (!(line instanceof NewRec)) throw new NotPorted(`account.move.line ${fname} recomputed on a stored line (${what})`);
    line.addToCompute(fname);
  }
}

/** account_move.py:8139-8147 `_conditional_add_to_compute` on the move (`is_protected(field, move._origin)`). */
async function moveAddToCompute(rec: NewRec, fname: string, condition: () => Promise<boolean>): Promise<void> {
  if (!(await condition())) return;
  if (rec.origin === null && (await rec.get(fname))) return; // `move._origin or not move[fname]`
  rec.addToCompute(fname);
}

// ------------------------------------------------------------------------------------------------- account.move

// account_move.py:2728-2735 `_inverse_partner_id`
registerOnchange("account.move", "_inverse_partner_id", ["partner_id"], async (env, rec) => {
  if (!(await isInvoice(rec, true))) return;
  const commercial = await rec.get("commercial_partner_id");
  if (commercial instanceof NewRec) throw new NotPorted("account.move commercial partner as a new record");
  const target = idOf(commercial);
  for (const line of await moveLines(rec, false)) {
    if (idOf(await line.get("partner_id")) === target) continue;
    if (!(line instanceof NewRec)) throw new NotPorted("account.move partner change over a stored line (_inverse_partner_id)");
    await line.set("partner_id", target ?? false);
    await lineInversePartner(line);
  }
});

// account_move.py:2737-2746 `_inverse_company_id`
registerOnchange("account.move", "_inverse_company_id", ["company_id"], async (env, rec) => {
  const company = idOf(await rec.get("company_id"));
  if (rec.values.get("company_id") instanceof NewRec) throw new NotPorted("account.move with a new company");
  if (!company) throw new ValidationError(translate(env, "We can't leave this document without any company. Please select a company for this document."));
  await moveAddToCompute(rec, "journal_id", async () => {
    const journal = idOf(await rec.get("journal_id"));
    if (!journal) return true;
    // account.journal `_check_company_domain`: no company, or a parent (or itself) of the move's company
    const row = (await env.cr.query<{ ok: boolean }>(
      `SELECT j.company_id IS NULL OR j.company_id::text = ANY(string_to_array(trim(trailing '/' from c.parent_path), '/')) AS ok
         FROM account_journal j, res_company c WHERE j.id = $1 AND c.id = $2`, [journal, company])).rows[0];
    return !row?.ok;
  });
});

// account_move.py:2748-2753 `_inverse_currency_id`
registerOnchange("account.move", "_inverse_currency_id", ["currency_id"], async (_env, rec) => {
  const invoice = await isInvoice(rec, true);
  const currency = idOf(await rec.get("currency_id"));
  await lineAddToCompute(await moveLines(rec, true), "currency_id", async (l) => invoice && currency !== idOf(await l.get("currency_id")), "_inverse_currency_id");
});

// account_move.py:2755-2764 `_inverse_journal_id`
registerOnchange("account.move", "_inverse_journal_id", ["journal_id"], async (env, rec) => {
  const journal = idOf(await rec.get("journal_id"));
  const row = journal ? (await env.cr.query<{ company_id: number | null; currency_id: number | null }>(
    "SELECT company_id, currency_id FROM account_journal WHERE id = $1", [journal])).rows[0] : undefined;
  await moveAddToCompute(rec, "company_id", async () => {
    const company = idOf(await rec.get("company_id"));
    return !company || company !== (row?.company_id ?? null);
  });
  await moveAddToCompute(rec, "currency_id", async () => {
    const currency = idOf(await rec.get("currency_id"));
    return !currency || (Boolean(row?.currency_id) && currency !== row!.currency_id);
  });
});

/** account_move.py:2766-2776: the payment term lines' label follows the payment reference and the terms. */
async function paymentTermNames(rec: NewRec, what: string): Promise<void> {
  await lineAddToCompute(await rec.rels("line_ids"), "name", async (l) => (await l.get("display_type")) === "payment_term", what);
}
registerOnchange("account.move", "_inverse_payment_reference", ["payment_reference"], async (_env, rec) => paymentTermNames(rec, "_inverse_payment_reference"));
registerOnchange("account.move", "_inverse_invoice_payment_term_id", ["invoice_payment_term_id"], async (_env, rec) => paymentTermNames(rec, "_inverse_invoice_payment_term_id"));

// account_move.py:2788-2791 `_onchange_date`
registerOnchange("account.move", "_onchange_date", ["date"], async (env, rec) => {
  if (await isInvoice(rec, true)) return;
  for (const line of await rec.rels("line_ids")) await lineInverseAmountCurrency(env, line);
});

// account_move.py:2793-2806 `_onchange_invoice_vendor_bill`
registerOnchange("account.move", "_onchange_invoice_vendor_bill", ["invoice_vendor_bill_id"], async (_env, rec) => {
  if (await rec.get("invoice_vendor_bill_id")) throw new NotPorted("account.move lines copied from a vendor bill (_onchange_invoice_vendor_bill)");
});

// account_move.py:2808-2810 `_onchange_fpos_id_show_update_fpos`: `self.line_ids and ...` (an empty recordset is False)
registerOnchange("account.move", "_onchange_fpos_id_show_update_fpos", ["fiscal_position_id"], async (_env, rec) => {
  const lines = await rec.get("line_ids");
  if (rec.values.get("fiscal_position_id") instanceof NewRec) throw new NotPorted("account.move with a new fiscal position");
  const before = rec.originRec ? idOf(await rec.originRec.get("fiscal_position_id")) : null;
  await rec.set("show_update_fpos", Array.isArray(lines) && lines.length > 0 && before !== idOf(await rec.get("fiscal_position_id")));
});

// account_move.py:2812-2822 `_onchange_partner_id`, then purchase account_invoice.py:121-144; with l10n_se
// (account_move.py:57-62, decorated for `partner_id` only) the vendor's OCR reference first
registerOnchange("account.move", "_onchange_partner_id", ["partner_id", "company_id"], async (env, rec) => {
  const partnerValue = await rec.get("partner_id");
  if (partnerValue instanceof NewRec) throw new NotPorted("account.move with a new partner");
  const partner = idOf(partnerValue);
  const source = (await generatedOnchanges(await templateOf(env.cr)))?.["account.move"]?.methods["_onchange_partner_id"]?.source ?? "";
  if (source.startsWith("addons/l10n_se/")) {
    if (partner && (await rec.get("move_type")) === "in_invoice") {
      const ref = (await env.cr.query<{ r: string | null }>("SELECT l10n_se_default_vendor_payment_ref AS r FROM res_partner WHERE id = $1", [partner])).rows[0]?.r;
      if (ref) await rec.set("payment_reference", ref);
    }
  } else if (!source.startsWith("addons/purchase/")) {
    throw new NotPorted(`account.move._onchange_partner_id of ${source}`);
  }
  const journal = idOf(await rec.get("journal_id"));
  const journalCompany = journal ? (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM account_journal WHERE id = $1", [journal])).rows[0]?.c ?? null : null;
  const company = journalCompany ?? await env.company();
  // `_accessible_branches()[:1]`: the company itself when the user may use it
  if (!(await env.companies()).includes(company)) throw new NotPorted("account.move partner onchange in a company the user cannot use (_accessible_branches)");
  const cenv = await withCompany(env, company);
  const p = partner ? new DbRec(cenv, env.reg.model("res.partner"), partner) : null;
  if (p && !(await p.get("property_account_receivable_id")) && !(await p.get("property_account_payable_id"))) {
    throw new NotPorted("account.move partner without receivable and payable accounts (RedirectWarning to the configuration)");
  }
  // purchase: the vendor's purchase currency
  const ctxCurrency = env.context["default_currency_id"];
  const purchaseCurrency = p ? idOf(await new DbRec(env, env.reg.model("res.partner"), partner!).get("property_purchase_currency_id")) : null;
  const currencyValue = await rec.get("currency_id");
  if (currencyValue instanceof NewRec) throw new NotPorted("account.move with a new currency");
  const current = idOf(currencyValue);
  const currency = purchaseCurrency ?? (typeof ctxCurrency === "number" && ctxCurrency ? ctxCurrency : null) ?? current;
  const type = String(await rec.get("move_type"));
  if (partner && (type === "in_invoice" || type === "in_refund") && current !== currency) {
    throw new NotPorted("account.move vendor bill in the vendor's purchase currency (journal search)");
  }
});

// account_move.py:2824-2890 `_onchange_name_warning`
registerOnchange("account.move", "_onchange_name_warning", ["name", "highest_name"], async (_env, rec) => {
  const name = await rec.get("name");
  const highest = await rec.get("highest_name");
  const n = typeof name === "string" ? name : "";
  const h = typeof highest === "string" ? highest : "";
  await rec.set("show_name_warning", Boolean(n) && n !== "/" && n <= h && !(await rec.get("document_sequence_editable")));
  let origin = rec.originRec ? await rec.originRec.get("name") : null;
  if (!origin || origin === "/") origin = highest;
  if (!n || n === "/" || !origin || origin === "/") return;
  const sameDate = (await rec.get("date")) === (rec.originRec ? await rec.originRec.get("date") : null);
  const sameJournal = idOf(await rec.get("journal_id")) === (rec.originRec ? idOf(await rec.originRec.get("journal_id")) : null);
  if (sameDate && sameJournal) throw new NotPorted("account.move sequence format comparison of a changed name (_get_sequence_format_param)");
});

// account_move.py:2892-2896 `_onchange_journal_id`
// with :994-1011 `_compute_name` called on the record (the name is emptied first, so it matches any date) and
// :2778-2782 `_inverse_name` (no payment reference without a name; `_update_sequence_made_gap` only acts on stored moves)
registerOnchange("account.move", "_onchange_journal_id", ["journal_id"], async (_env, rec) => {
  if (await rec.get("document_sequence_editable")) return;
  if (rec.origin !== null) throw new NotPorted("account.move journal change of a stored move (_update_sequence_made_gap)");
  await rec.set("name", null);
  const state = await rec.get("state");
  if (state !== "cancel" && (await rec.get("date")) && state !== "draft") throw new NotPorted("account.move name of a posted move from the compute (_set_next_sequence)");
});

// account_move.py:2898-2905 `_onchange_document_tax_mode`
registerOnchange("account.move", "_onchange_document_tax_mode", ["document_tax_mode"], async (_env, rec) => {
  const mode = await rec.get("document_tax_mode");
  for (const line of await rec.rels("invoice_line_ids")) {
    if (line instanceof NewRec) { await line.set("document_tax_mode", mode); continue; }
    if ((await line.get("document_tax_mode")) !== mode) throw new NotPorted("account.move tax mode change over a stored line");
  }
});

// account_move.py:2907-2919 `_onchange_ineffective_cash_rounding`
registerOnchange("account.move", "_onchange_ineffective_cash_rounding", ["invoice_cash_rounding_id", "tax_totals"], async (env, rec) => {
  const rounding = idOf(await rec.get("invoice_cash_rounding_id"));
  if (!rounding) return;
  const strategy = (await env.cr.query<{ s: string | null }>("SELECT strategy AS s FROM account_cash_rounding WHERE id = $1", [rounding])).rows[0]?.s;
  if (strategy === "biggest_tax") throw new NotPorted("account.move cash rounding on the biggest tax (compute_difference)");
});

// purchase account_invoice.py:39-60 `_onchange_purchase_auto_complete`: the union field is always emptied
registerOnchange("account.move", "_onchange_purchase_auto_complete", ["purchase_vendor_bill_id", "purchase_id"], async (_env, rec) => {
  if (await rec.get("purchase_vendor_bill_id")) throw new NotPorted("account.move auto-complete from a purchase order or bill");
  await rec.set("purchase_vendor_bill_id", false);
  if (await rec.get("purchase_id")) throw new NotPorted("account.move lines from a purchase order (_onchange_purchase_auto_complete)");
});

// account_move.py:4626-4639 `_quick_edit_mode_suggest_invoice_date`
registerOnchange("account.move", "_quick_edit_mode_suggest_invoice_date", ["quick_edit_mode", "journal_id", "company_id"], async (_env, rec) => {
  if ((await rec.get("quick_edit_mode")) && !(await rec.get("invoice_date"))) {
    throw new NotPorted("account.move invoice date suggested in quick edit mode (_get_accounting_date)");
  }
});

// account_move.py:4641-4662 `_onchange_quick_edit_total_amount`
registerOnchange("account.move", "_onchange_quick_edit_total_amount", ["quick_edit_total_amount", "partner_id"], async (_env, rec) => {
  const lines = await rec.get("invoice_line_ids");
  if (!(await rec.get("quick_edit_total_amount")) || !(await rec.get("quick_edit_mode")) || (Array.isArray(lines) && lines.length > 0)) return;
  throw new NotPorted("account.move quick encoding line from the total amount");
});

// account_move.py:4664-4676 `_onchange_quick_edit_line_ids`
registerOnchange("account.move", "_onchange_quick_edit_line_ids", ["invoice_line_ids"], async (env, rec) => {
  const suggestion = env.context["quick_encoding_vals"];
  const lines = await rec.rels("invoice_line_ids");
  if (!(await rec.get("quick_edit_total_amount")) || !(await rec.get("quick_edit_mode")) || !lines.length || !suggestion) return;
  if (typeof suggestion !== "object" || Array.isArray(suggestion)) throw new NotPorted("account.move quick_encoding_vals in the context");
  if ((suggestion as Record<string, unknown>)["price_unit"] !== await lines[lines.length - 1]!.get("price_unit")) return;
  throw new NotPorted("account.move quick encoding total check (_check_total_amount)");
});

// -------------------------------------------------------------------------------------------- account.move.line

/** account_move_line.py:1753-1757 `_inverse_partner_id`. */
async function lineInversePartner(line: Rec): Promise<void> {
  await lineAddToCompute([line], "account_id", async (l) => (await l.get("display_type")) === "payment_term", "_inverse_partner_id");
}
registerOnchange("account.move.line", "_inverse_partner_id", ["partner_id"], async (_env, rec) => lineInversePartner(rec));

// account_move_line.py:1759-1764 `_inverse_product_id`
registerOnchange("account.move.line", "_inverse_product_id", ["product_id"], async (_env, rec) => {
  if (!(await rec.get("product_id")) && (await rec.get("account_id"))) return;
  await lineAddToCompute([rec], "account_id", async (l) => {
    if ((await l.get("display_type")) !== "product") return false;
    const move = await l.rel("move_id");
    return move !== null && isInvoice(move, true);
  }, "_inverse_product_id");
});

/** account_move_line.py:1766-1777 `_inverse_amount_currency`. */
async function lineInverseAmountCurrency(env: Environment, line: Rec): Promise<void> {
  const company = await line.rel("company_id");
  const companyCurrency = company ? idOf(await company.get("currency_id")) : null;
  const currency = idOf(await line.get("currency_id"));
  const amount = Number((await line.get("amount_currency")) ?? 0), balance = Number((await line.get("balance")) ?? 0);
  if (currency === companyCurrency) {
    if (balance === amount) return;
    if (!(line instanceof NewRec)) throw new NotPorted("account.move.line balance of a stored line in the form");
    await line.set("balance", amount);
    return;
  }
  const move = await line.rel("move_id");
  if (move && (await isInvoice(move, true))) return;
  if (line instanceof NewRec && line.protectedFields.has("balance")) return;
  void env;
  throw new NotPorted("account.move.line balance from a foreign currency amount (currency_rate)");
}
registerOnchange("account.move.line", "_inverse_amount_currency", ["amount_currency", "currency_id"], async (env, rec) => lineInverseAmountCurrency(env, rec));

/** account_move_line.py:1779-1793 `_inverse_debit` / `_inverse_credit`. */
function debitCredit(own: "debit" | "credit", other: "debit" | "credit") {
  return async (_env: Environment, rec: NewRec): Promise<void> => {
    const v = Number((await rec.get(own)) ?? 0);
    await rec.set("is_storno", v < 0);
    if (v) await rec.set(other, 0);
    await rec.set("balance", Number((await rec.get("debit")) ?? 0) - Number((await rec.get("credit")) ?? 0));
  };
}
registerOnchange("account.move.line", "_inverse_debit", ["debit"], debitCredit("debit", "credit"));
registerOnchange("account.move.line", "_inverse_credit", ["credit"], debitCredit("credit", "debit"));

// account_move_line.py:1814-1819 `_inverse_account_id` with :1795-1812 `_inverse_analytic_distribution` (no
// '__update__' key: the distribution is assigned as it is, analytic_mixin.py:244-246) and the taxes of the account
registerOnchange("account.move.line", "_inverse_account_id", ["account_id"], async (env, rec) => {
  if (!env.context["skip_analytic_sync"]) {
    if ((await rec.get("parent_state")) === "posted") throw new NotPorted("account.move.line analytic lines of a posted line (_inverse_analytic_distribution)");
    const dist = await rec.get("analytic_distribution");
    if (dist && typeof dist === "object" && "__update__" in dist) throw new NotPorted("account.move.line analytic distribution update (_merge_distribution)");
    await rec.set("analytic_distribution", dist && typeof dist === "object" && Object.keys(dist).length ? dist : null);
  }
  await lineAddToCompute([rec], "tax_ids", async (l) => {
    const company = idOf(await l.get("company_id"));
    const account = idOf(await l.get("account_id"));
    if (isNew(await l.get("account_id")) || isNew(await l.get("product_id"))) throw new NotPorted("account.move.line taxes of a new account or product");
    const sudo = env.sudo();
    const taxCompanies = async (taxIds: unknown): Promise<(number | null)[]> => {
      const ids = Array.isArray(taxIds) ? taxIds.filter((t): t is number => typeof t === "number") : [];
      if (!ids.length) return [];
      return (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM account_tax WHERE id = ANY($1::int[])", [ids])).rows.map((r) => r.c);
    };
    const accountTaxes = account ? await taxCompanies(await new DbRec(sudo, env.reg.model("account.account"), account).get("tax_ids")) : [];
    if (!accountTaxes.includes(company)) return false;
    const product = idOf(await l.get("product_id"));
    const productTaxes = product ? await taxCompanies(await new DbRec(sudo, env.reg.model("product.product"), product).get("taxes_id")) : [];
    return !productTaxes.includes(company);
  }, "_inverse_account_id");
});

// account_move_line.py:839-856 `_compute_balance` of a line in the form: sections and notes have none, an invoice
// line starts at 0; a line of an entry balances the other lines (the context's `line_ids`), which is not ported.
// A stored line keeps refusing (its balance is written by the callers).
registerRecordCompute("account.move.line", {
  balance: async (_env, rec) => {
    if (!(rec instanceof NewRec) || rec.origin !== null) throw new NotPorted("compute of account.move.line.balance on a record");
    if (["line_section", "line_subsection", "line_note"].includes(String(await rec.get("display_type")))) return 0.0;
    const move = await rec.rel("move_id");
    if (move && (await isInvoice(move, true))) return 0.0;
    throw new NotPorted("account.move.line.balance of a new entry line (the balance of the other lines)");
  },
});

// account_move_line.py:1599-1612 `_compute_analytic_distribution` in the form (with purchase account_invoice.py:684-693
// and sale account_move_line.py:45-49 `_related_analytic_distribution`): without a distribution on the purchase or sale
// line and without any distribution model, `{} | {} or line.analytic_distribution` keeps the line's value
registerRecordCompute("account.move.line", {
  analytic_distribution: async (env, rec) => {
    if (!(rec instanceof NewRec)) return storedLineAnalyticDistribution(env, rec);
    const current = await rec.prev("analytic_distribution");
    const move = await rec.rel("move_id");
    if (!((await rec.get("display_type")) === "product" || !(move && (await isInvoice(move, true))))) return current;
    if (isNew(await rec.get("purchase_line_id"))) throw new NotPorted("account.move.line analytic distribution of a new purchase line");
    const purchaseLine = idOf(await rec.get("purchase_line_id"));
    const saleLines = await rec.get("sale_line_ids");
    if (Array.isArray(saleLines) && saleLines.length) throw new NotPorted("account.move.line analytic distribution from its sale line");
    if (purchaseLine) {
      const d = (await env.cr.query<{ d: unknown }>("SELECT analytic_distribution AS d FROM purchase_order_line WHERE id = $1", [purchaseLine])).rows[0]?.d;
      if (d && typeof d === "object" && Object.keys(d).length) throw new NotPorted("account.move.line analytic distribution from its purchase line");
    }
    const models = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n;
    if (Number(models ?? 0)) throw new NotPorted("account.move.line analytic distribution models (_get_distribution)");
    return current;
  },
});

/**
 * The same compute on a stored line (account_move_line.py:1599-1612, triggered by purchase account_invoice.py:691
 * `purchase_line_id.analytic_distribution`, e.g. a confirmed order's vendor or project changed): a product line, or a
 * line of an entry that is not an invoice, takes `related | _get_distribution(...) or line.analytic_distribution`,
 * where `related` is its purchase line's distribution (purchase account_invoice.py:684-689) or its first sale line's
 * (sale account_move_line.py:45-49); without distribution models `_get_distribution` is empty.
 */
async function storedLineAnalyticDistribution(env: Environment, rec: Rec): Promise<unknown> {
  const current = await rec.prev("analytic_distribution");
  const move = await rec.rel("move_id");
  if (!((await rec.get("display_type")) === "product" || !(move && (await isInvoice(move, true))))) return current;
  const models = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM account_analytic_distribution_model")).rows[0]?.n;
  if (Number(models ?? 0)) throw new NotPorted("account.move.line analytic distribution models (_get_distribution)");
  const filled = (d: unknown): d is Record<string, unknown> => Boolean(d) && typeof d === "object" && Object.keys(d as object).length > 0;
  let related: Record<string, unknown> | null = null;
  if (rec.def.fields.has("purchase_line_id")) {
    const line = await rec.rel("purchase_line_id");
    const d = line ? await line.get("analytic_distribution") : null;
    if (filled(d)) related = d;
  }
  if (rec.def.fields.has("sale_line_ids")) {
    const ids = await rec.get("sale_line_ids");
    if (Array.isArray(ids) && ids.length) {
      // `self.sale_line_ids[0]`: the first in the sale line order (order_id, sequence, id)
      const first = (await env.cr.query<{ id: number }>("SELECT id FROM sale_order_line WHERE id = ANY($1::int[]) ORDER BY order_id, sequence, id LIMIT 1", [ids])).rows[0];
      const d = first ? await new DbRec(env, env.reg.model("sale.order.line"), first.id).get("analytic_distribution") : null;
      if (filled(d)) {
        if (related) throw new NotPorted("account.move.line analytic distribution from both its sale and purchase lines (the order of the overrides)");
        related = d;
      }
    }
  }
  return related ?? current;
}
