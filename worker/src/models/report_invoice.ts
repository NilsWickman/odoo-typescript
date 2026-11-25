/**
 * The Python methods the invoice report templates call (account/views/report_invoice.xml, web/views/report_templates.xml).
 */
import { partnerEmailFormatted } from "../mail/message";
import { NotPorted } from "../errors";
import { isHtmlEmpty } from "../qweb/helpers";
import { DbRec, type Rec } from "../orm/recompute";
import { pyStr } from "../pyexpr/values";
import { PyRecords, registerPyMethod } from "../qweb/records";
import { allIdentifiers, allIdentifiersMetadata } from "./res_partner_erp_write";
import { defineComputes } from "./tail_util";
import { translate } from "./util";
import { plainNumber, pyFloat } from "../orm/values";
import * as priv from "../orm/dispatch_gen";

// base res_lang.py:314 `_get_data`: the LangData of an active language, else a dummy with every field False
registerPyMethod("res.lang", "_get_data", async (recs, _args, kwargs) => {
  const code = kwargs.get("code");
  if (code === undefined) throw new NotPorted("res.lang._get_data on another key");
  const r = (await recs.env.cr.query<{ direction: string; code: string; name: string; url_code: string }>(
    "SELECT direction, code, name, url_code FROM res_lang WHERE active AND code = $1", [code])).rows[0];
  return r ? { ...r } : { direction: false, code: false, name: false, url_code: false };
});

// account_move.py:8198-8202 `_get_name_invoice_report`: through callPrivate, so that a localization's compiled override
// (l10n_ae, l10n_gcc_invoice, l10n_nz, l10n_zm_account, ...: its own report template for its country) answers
registerPyMethod("account.move", "_get_name_invoice_report", (recs) =>
  priv.account_move._get_name_invoice_report.call(recs.env, recs.ids, [], async () => { recs.ensureOne(); return "account.report_invoice_document"; }));

defineComputes("res.company", {
  // web models.py _compute_empty_company_details: `not html2plaintext(company_details or '')`
  is_company_details_empty: async (_env, rec) => isHtmlEmpty(await rec.get("company_details")),
  // mail res_company.py:55-63 `_compute_email_formatted`: the partner's, else the catchall's (alias domains refuse)
  email_formatted: async (env, rec) => {
    const partner = await rec.get("partner_id");
    const formatted = typeof partner === "number" ? await partnerEmailFormatted(env, partner) : false;
    if (formatted) return formatted;
    if (await rec.get("alias_domain_id")) throw new NotPorted("res.company.email_formatted through the catchall");
    return "";
  },
});

/** base res_partner.py:1608-1631 `_pick_preferred_identifier` over `_get_all_identifiers(enrich=True)`. */
async function preferredIdentifier(partner: PyRecords, priorities: Record<string, number>, legal: boolean): Promise<Record<string, unknown> | null> {
  const commercial = (await partner.field("commercial_partner_id")) as PyRecords;
  const rec = new DbRec(partner.env, partner.env.reg.model("res.partner"), commercial.ids[0]!);
  const all = await allIdentifiers(rec);
  const metadata = await allIdentifiersMetadata(partner.env);
  const rank = (cat: unknown): number => priorities[String(cat)] ?? 100;
  const candidates = Object.entries(all).map(([key, value]) => ({ key, value, meta: (metadata[key] ?? {}) as Record<string, unknown> }))
    .filter((c) => String(c.meta["category"]) in priorities || c.key === "TIN");
  if (!candidates.length) return null;
  const sequence = (m: Record<string, unknown>): number => Number(m["sequence"] ?? 100);
  const tuple = (m: Record<string, unknown>): [number, number] => (legal ? [sequence(m), rank(m["category"])] : [rank(m["category"]), sequence(m)]);
  candidates.sort((a, b) => { const x = tuple(a.meta), y = tuple(b.meta); return x[0] - y[0] || x[1] - y[1]; });
  const best = candidates[0]!;
  // res_partner.py:1629-1631 `_lazy_translate_additional_identifiers_metadata` (:1652-1657): a lazy label is
  // `env._(value)`, LazyGettext._translate in env.lang with its module's terms (partner_identifiers.py's are base's; a
  // localization's metadata keeps its module, compiler/runtime/install.ts privateKey). It printed "[object Object]".
  const meta = Object.fromEntries(Object.entries(best.meta).map(([k, v]) => {
    const lazy = v as { kind?: unknown; source?: unknown; module?: unknown } | null;
    if (lazy && typeof lazy === "object" && lazy.kind === "lazy" && typeof lazy.source === "string") {
      return [k, translate(partner.env, lazy.source, typeof lazy.module === "string" ? lazy.module : "base")];
    }
    return [k, v];
  }));
  return { key: best.key, value: best.value, ...meta };
}

// account_move.py:8355-8366 `_get_document_partner_ident_line`
registerPyMethod("account.move", "_get_document_partner_ident_line", async (recs) => {
  const partner = (await recs.field("partner_id")) as PyRecords;
  if (!partner.ids.length) return "";
  const tax = await preferredIdentifier(partner, { VAT: 0, TIN: 0, GST: 0 }, false);
  if (tax) {
    const company = (await recs.field("company_id")) as PyRecords;
    const country = (await company.field("account_fiscal_country_id")) as PyRecords;
    const label = country.ids.length ? await country.field("vat_label") : false;
    return `${String(label || tax["category"] || "Tax ID")}: ${String(tax["value"])}`;
  }
  const legal = await preferredIdentifier(partner, { EN: 0, VAT: 1, TIN: 1, GST: 1, CN: 2 }, true);
  return legal ? `${String(legal["label"] || legal["key"])}: ${String(legal["value"])}` : "";
});

// account_move.py:8263-8273 `_get_move_lines_to_report`: every section, and the other lines unless their section or
// its parent hides the composition or the prices (collapse_composition, collapse_prices). A section with either flag
// is rendered by `_get_child_lines` (report_invoice.xml:262-340), which is not ported: refused.
registerPyMethod("account.move", "_get_move_lines_to_report", async (recs) => {
  const lines = (await recs.field("invoice_line_ids")) as PyRecords;
  const out: { id: number; sequence: number }[] = [];
  for (const line of lines.pyIter() as PyRecords[]) {
    if (["line_section", "line_subsection"].includes(String(await line.field("display_type")))
      && (await line.field("collapse_composition") || await line.field("collapse_prices"))) {
      throw new NotPorted("invoice report with a section hiding its composition or prices (_get_child_lines)");
    }
    out.push({ id: line.ids[0]!, sequence: Number(await line.field("sequence")) });
  }
  // sorted('sequence') is stable
  return lines.browse(out.map((l, i) => [l, i] as const).sort((a, b) => a[0].sequence - b[0].sequence || a[1] - b[1]).map(([l]) => l.id));
});

/**
 * account_move_line.py:4039-4049 `get_section_subtotal`/`get_section_total` over `_get_section_lines`: the invoice
 * lines whose parent is the section, or whose parent is a subsection of it (product_catalog_line_mixin.py:36-46
 * `_is_line_in_section`), summed in the invoice lines' order (Python's `sum`, from the integer 0).
 */
async function sectionSum(recs: PyRecords, field: "price_subtotal" | "price_total"): Promise<unknown> {
  const id = recs.ensureOne();
  const move = await recs.field("move_id") as PyRecords;
  const kind = String(await recs.field("display_type"));
  const lines = (await move.field("invoice_line_ids")) as PyRecords;
  let total = 0, summed = false;
  for (const line of lines.pyIter() as PyRecords[]) {
    const parent = (await line.field("parent_id")) as PyRecords;
    const parentId = parent.ids[0];
    let inSection = parentId === id;
    if (!inSection && kind === "line_section" && parentId !== undefined && String(await parent.field("display_type")) === "line_subsection") {
      inSection = ((await parent.field("parent_id")) as PyRecords).ids[0] === id;
    }
    if (inSection) {
      const v = plainNumber(await line.field(field));
      total += typeof v === "number" ? v : Number(v);
      summed = true;
    }
  }
  // the float sum of the lines' monetary values; `sum([])` is the integer 0
  return summed ? pyFloat(total) : 0;
}
registerPyMethod("account.move.line", "get_section_subtotal", (recs) => sectionSum(recs, "price_subtotal"));
registerPyMethod("account.move.line", "get_section_total", (recs) => sectionSum(recs, "price_total"));

defineComputes("account.move.line", {
  // account_move_line.py:1669-1694 `_compute_parent_id`: the last section above a note or product line (or the last
  // subsection under it), in the move's lines sorted by sequence (stable over `_order`, by id within a move)
  parent_id: async (env, line) => {
    if (line.id === null) throw new NotPorted("account.move.line.parent_id of a new line");
    const move = await line.get("move_id");
    if (typeof move !== "number" || !move) return null;
    const rows = (await env.cr.query<{ id: number; display_type: string | null }>(
      "SELECT id, display_type FROM account_move_line WHERE move_id = $1 ORDER BY sequence, id", [move])).rows;
    let section: number | null = null, sub: number | null = null;
    for (const r of rows) {
      let value: number | null = null;
      if (r.display_type === "line_section") { section = r.id; sub = null; value = null; }
      else if (r.display_type === "line_subsection") { value = section; sub = r.id; }
      else if (r.display_type === "line_note" || r.display_type === "product") value = sub ?? section;
      if (r.id === line.id) return value;
    }
    return null;
  },
});

// account_move.py:3074-3089 `_is_eligible_for_early_payment_discount`
registerPyMethod("account.move", "_is_eligible_for_early_payment_discount", async (recs, args) => {
  recs.ensureOne();
  const [currency, reference] = args;
  if (!(await recs.field("currency_id") as PyRecords).pyEquals(currency)) return false;
  if (!["out_invoice", "out_receipt", "in_invoice", "in_receipt"].includes(String(await recs.field("move_type")))) return false;
  const term = (await recs.field("invoice_payment_term_id")) as PyRecords;
  if (!term.ids.length || !(await term.field("early_discount"))) return false;
  void reference;
  throw new NotPorted("_is_eligible_for_early_payment_discount with an early discount");
});

// sale_stock account_move.py:12-90 `_get_invoiced_lot_values`: done lot move lines of the invoiced sale lines are not ported
registerPyMethod("account.move", "_get_invoiced_lot_values", async (recs) => {
  const id = recs.ensureOne();
  const state = await recs.field("state"), type = await recs.field("move_type");
  if (state === "draft" || !(await recs.field("invoice_date")) || !["out_invoice", "out_refund"].includes(String(type))) return [];
  const lots = await recs.env.cr.query(
    `SELECT 1 FROM account_move_line aml
       JOIN sale_order_line_invoice_rel rel ON rel.invoice_line_id = aml.id
       JOIN stock_move sm ON sm.sale_line_id = rel.order_line_id
       JOIN stock_move_line sml ON sml.move_id = sm.id
      WHERE aml.move_id = $1 AND sml.state = 'done' AND sml.lot_id IS NOT NULL LIMIT 1`, [id]);
  if (lots.rows.length) throw new NotPorted("invoice report with lots (_get_invoiced_lot_values)");
  return [];
});

// uom_uom.py:139-178 `_compute_quantity`
registerPyMethod("uom.uom", "_compute_quantity", async (recs, args) => {
  const [qty, to] = args;
  if (!recs.ids.length || !qty) return qty;
  if (recs.pyEquals(to)) return qty;
  throw new NotPorted("uom.uom._compute_quantity between different units in a template");
});

defineComputes("account.tax", {
  // account_tax.py:654-656 _compute_tax_label
  tax_label: async (_env, rec) => (await rec.get("invoice_label")) || (await rec.get("name")) || false,
});

const EPD_TYPES = ["out_invoice", "out_receipt", "in_invoice", "in_receipt"];
/** account_move.py:1960-1974 `_compute_show_payment_term_details`. */
async function paymentTermFlags(rec: Rec): Promise<{ show: boolean; discount: boolean }> {
  if (!EPD_TYPES.includes(String(await rec.get("move_type"))) || !["not_paid", "partial"].includes(String(await rec.get("payment_state")))) return { show: false, discount: false };
  const terms = (await rec.rels("line_ids"));
  let count = 0;
  for (const l of terms) if ((await l.get("display_type")) === "payment_term") count++;
  const term = await rec.rel("invoice_payment_term_id");
  const discount = term ? Boolean(await term.get("early_discount")) : false;
  return { show: count > 1 || discount, discount };
}

defineComputes("account.move", {
  // account_move.py:2323-2328 _compute_display_link_qr_code
  display_link_qr_code: async (_env, rec) => {
    if (!EPD_TYPES.includes(String(await rec.get("move_type")))) return false;
    const company = await rec.rel("company_id");
    return company ? Boolean(await company.get("link_qr_code")) : false;
  },
  show_payment_term_details: async (_env, rec) => (await paymentTermFlags(rec)).show,
  show_discount_details: async (_env, rec) => (await paymentTermFlags(rec)).discount,
  // account_move.py:1944-1958 _compute_payment_term_details
  payment_term_details: async (env, rec) => {
    if (!(await paymentTermFlags(rec)).show) return false;
    throw new NotPorted(`account.move.payment_term_details of ${env.lang ?? "en_US"} installments`);
  },
  // account_move.py:2476-2482 _compute_taxes_legal_notes
  taxes_legal_notes: async (_env, rec) => {
    const seen = new Set<number>();
    let out = "";
    for (const line of await rec.rels("line_ids")) {
      for (const tax of await line.rels("tax_ids")) {
        if (seen.has(tax.origin!)) continue;
        seen.add(tax.origin!);
        const notes = await tax.get("invoice_legal_notes");
        if (!isHtmlEmpty(notes)) out += pyStr(notes);
      }
    }
    return out;
  },
});

// ir_actions_report.py:185-189 `get_paperformat` / `get_paperformat_by_xmlid` (web.minimal_layout's margins class)
registerPyMethod("ir.actions.report", "get_paperformat_by_xmlid", async (recs, args, kwargs) => {
  const xmlid = args[0] ?? kwargs.get("xml_id");
  const env = recs.env;
  const company = async (): Promise<PyRecords> => {
    const c = (await env.cr.query<{ p: number | null }>("SELECT paperformat_id AS p FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.p ?? null;
    return new PyRecords(env, "report.paperformat", c ? [c] : []);
  };
  if (!xmlid) return company();
  const [module, name] = String(xmlid).split(".", 2);
  const row = (await env.cr.query<{ model: string; res_id: number }>("SELECT model, res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name])).rows[0];
  if (!row) throw new NotPorted(`env.ref of a missing xmlid ${String(xmlid)} (ValueError)`);
  if (row.model !== "ir.actions.report") throw new NotPorted(`get_paperformat of ${row.model}`);
  const own = (await env.cr.query<{ p: number | null }>("SELECT paperformat_id AS p FROM ir_act_report_xml WHERE id = $1", [row.res_id])).rows[0]?.p ?? null;
  return own ? new PyRecords(env, "report.paperformat", [own]) : company();
});
