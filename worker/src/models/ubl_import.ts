/**
 * The UBL import of account_edi_ubl_cii for Peppol BIS 3 vendor bills (K2-base round 7, step 1 of the import: a
 * supplier that exists; round 8, step 2: its bank account, found or created; step 3: a new supplier, after the whole
 * search plan; step 4: the document's currency, active or inactive; step 5: the embedded PDF; step 6: allowances and charges of the document, the lines and the prices; step 7: purchase order references
 * without a matching order). Followed line by line; every part says where it comes from. What step 1 does not port
 * refuses (NotPorted) before anything is written:
 *  - other formats: CII and Factur-X, UBL 2.0/2.1, XRechnung, NLCIUS, A-NZ, SG, AttachedDocument;
 *  - a supplier found without a VAT (it would get the file's), without a name or a VAT; several bank accounts in the
 *    file or one of the database's companies;
 *  - credit notes, line charges with reason AEO (fixed taxes), quantities and discounts beyond the usual precision,
 *    prepaid amounts, incoterms, a purchase order the references or the vendor and total match,
 *    product identifiers or a product the line name finds, vehicles, taxes not found (they log), embedded documents
 *    other than PDFs.
 *
 * Entry points: `bis3Tree` (src/models/ubl_tree.ts: the file's tree when the BIS 3 decoder takes it, account_edi_ubl_cii account_move.py:
 * 214-242 and 307-324) and `importBis3` (the decoder, account_edi_xml_ubl_bis3.py:469-480 -> account_edi_ubl.py:
 * 3038-3101 `_ubl_import_invoice`, then the rest of account_move.py:5015-5057 `_extend_with_attachments`). The
 * callers are src/mail/move_import.ts (a file posted with a message, a file uploaded to the bill).
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import type { Element } from "../xml";
import { BIS3, bis3Tree, find, findall, findtext, isoDate, pyFloat, qname } from "./ubl_tree";
import { write as ormWrite } from "../orm/write";
import { create as ormCreate } from "../orm/create";
import { floatRound, floatRoundRounding } from "../orm/convert";
import { translate } from "./util";
import { fiscalPositionFor } from "./sale_computes";
import { addressGet } from "./tail_util";
import { hasPdfEngine } from "../report/engine";
import { requestOfCursor } from "../http/context";
import { computeAuthor, insertMessages, trackingMessageId, xmlid } from "../mail/message";
import { flatThreadParent, permissionOn, recordCompany } from "../mail/thread_generic";
import { notifyThread } from "../mail/notify";
import { sanitizeBody } from "../mail/sanitize";
import { cond } from "../orm/domain";
import { createBinaryAttachment } from "./account_move_send_mail";
import { ValidationError } from "../errors";
import { allIdentifiersMetadata } from "./res_partner_erp_write";
import { ADDITIONAL_IDENTIFIERS_METADATA, TIN_METADATA } from "./partner_identifiers";
import { runVatChecks } from "./res_partner_write";
import { IDENTIFIER_VALIDATORS } from "./identifier_validators";
import { trackPrepare } from "../mail/tracking";
import { closeTrackingScope } from "../mail/write_hooks";
import * as priv from "../orm/dispatch_gen";

type Written = Record<string, Record<string, string[]>>;

// ------------------------------------------------------------------------------------------------ helpers

interface Currency { id: number; name: string; rounding: number }

const isZero = (c: Currency, v: number): boolean => Math.abs(floatRoundRounding(v, c.rounding)) < c.rounding;
const roundCur = (c: Currency, v: number): number => floatRoundRounding(v, c.rounding);

/** The company and its parents (`parent_of`, res_company.parent_path). */
async function companyAncestors(env: Environment, company: number): Promise<number[]> {
  const path = (await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [company])).rows[0]?.p ?? `${company}/`;
  return path.split("/").filter(Boolean).map(Number);
}

/** Python `re` `\d` in a pattern over `str`: any decimal digit. */
const pyRegex = (pattern: string): RegExp => new RegExp(pattern.replace(/\\d/g, "\\p{Nd}"), "gu");

/** markupsafe `escape`, which `_get_notes` applies (account_edi_ubl.py:2254-2257). */
const markupEscape = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");

interface TaxTotal { amountType: "percent"; typeTaxUse: string; amount: number; code: string; taxAmount: number; related: TaxValues[] }
interface TaxValues { amount: number; code: string; key: string; tax?: number | null }
interface DocAllowance { amount: number; base: number | null; multiplier: number | null; reason: string | null; charge: boolean; taxes: TaxValues | null }
interface LineValues {
  name: string; productName: string | null; quantity: number; priceUnit: number; discount: number;
  uomCode: string | null; uom?: number; taxes: TaxValues[];
}

// ------------------------------------------------------------------------------------------------ the import

/**
 * account_edi_xml_ubl_bis3.py:469-480 `_import_invoice_ubl_cii` -> account_edi_ubl.py:3038-3101 `_ubl_import_invoice`
 * on `moveId` (an account.move without lines), then account_move.py:5024-5055 after the decoder. `attachmentId` is the
 * file's ir.attachment. Returns the fields Odoo's request version lists for these writes: `rollbackable_transaction`
 * (account_document_import_mixin.py:29-69) commits before and after the decoder, so the version of the request keeps
 * only what is written after it (measured in vagb_move_ubl): the caller replaces what it recorded before with these.
 */
export async function importBis3(env: Environment, moveId: number, attachmentId: number, tree: Element): Promise<Written> {
  const move = (await env.cr.query<{ move_type: string; state: string; company_id: number; journal_type: string; lines: number; main: number | null; main_mimetype: string | null }>(
    `SELECT m.move_type, m.state, m.company_id, j.type AS journal_type, (SELECT count(*)::int FROM account_move_line l WHERE l.move_id = m.id) AS lines,
            m.message_main_attachment_id AS main, a.mimetype AS main_mimetype
       FROM account_move m JOIN account_journal j ON j.id = m.journal_id LEFT JOIN ir_attachment a ON a.id = m.message_main_attachment_id
      WHERE m.id = $1`, [moveId])).rows[0];
  if (!move) throw new NotPorted("a UBL file on a missing invoice");
  // account_edi_xml_ubl_bis3.py:478-479: an invoice with lines answers `_reason_cannot_decode_has_invoice_lines`,
  // which `_extend_with_attachments` posts (account_document_import_mixin.py:330-337)
  if (move.lines) throw new NotPorted("a UBL file on an invoice that has lines (the 'not imported' message)");
  const company = move.company_id;

  // :2118-2119 -> account_edi_common.py:1314-1326 `_import_init_collected_values`: the journal decides sale/purchase
  const documentType = move.journal_type === "sale" ? "sale" : "purchase";
  if (documentType !== "purchase" || move.move_type !== "in_invoice") throw new NotPorted(`a UBL file on a ${move.move_type} of a ${move.journal_type} journal`);
  const to: Record<string, unknown> = {};

  // :2121-2122 -> account_edi_common.py:1328-1332, account_edi_xml_ubl_20.py:1317-1330 `_get_import_document_amount_sign`
  const root = qname(tree);
  if (root === "{urn:oasis:names:specification:ubl:schema:xsd:CreditNote-2}CreditNote") throw new NotPorted("a UBL credit note (the move type and quantities turned)");
  if (root !== "{urn:oasis:names:specification:ubl:schema:xsd:Invoice-2}Invoice") throw new NotPorted(`a BIS 3 document ${root}`);
  const inclusive = find(tree, ".//{*}LegalMonetaryTotal/{*}TaxInclusiveAmount");
  if (inclusive !== null && pyFloat(inclusive.text ?? "") < 0) throw new NotPorted("a UBL invoice with a negative total (a credit note)");
  const sign = 1;
  // :2124-2125 -> account_edi_common.py:1334-1347: in_invoice stays in_invoice

  // :2214-2218 `_import_ubl_invoice_add_partner_bank_values`
  // a Python set: with several numbers its order (and so the accounts created) follows the string hashes
  const accountNumbers = [...new Set(findall(tree, "./{*}PaymentMeans/{*}PayeeFinancialAccount/{*}ID").map((n) => n.text))];
  if (accountNumbers.length > 1) throw new NotPorted("several bank account numbers in a UBL file (the order of a Python set)");
  if (accountNumbers.some((n) => !n)) throw new NotPorted("an empty bank account number in a UBL file");

  // :2127-2169 `_import_ubl_invoice_add_customer_values` (the supplier on a purchase document)
  const party = find(tree, "./{*}AccountingSupplierParty/{*}Party");
  if (party === null) throw new NotPorted("a UBL file without a supplier party (no partner)");
  const first = (xpaths: readonly string[]): string | null => {
    for (const x of xpaths) { const n = find(party, x); if (n !== null) return n.text; }
    return null;
  };
  const cv: CustomerValues = {
    vat: first([".//{*}CompanyID"]), phone: first([".//{*}Telephone"]), name: first([".//{*}RegistrationName", ".//{*}Name"]),
    email: first([".//{*}ElectronicMail"]), country_code: first([".//{*}Country//{*}IdentificationCode"]), street: first([".//{*}StreetName"]),
    street2: first([".//{*}AdditionalStreetName"]), city: first([".//{*}CityName"]), zip: first([".//{*}PostalZone"]),
    routing_scheme: null, routing_endpoint: null, additional_identifiers: {},
  };
  const metadata = await allIdentifiersMetadata(env);
  const endpoint = find(party, ".//{*}EndpointID");
  if (endpoint !== null && endpoint.text) {
    const scheme = endpoint.attrib.get("schemeID") ?? null;
    const value = endpoint.text.trim();
    cv.routing_scheme = scheme;
    cv.routing_endpoint = value;
    const meta = scheme === null ? undefined : Object.entries(metadata).find(([, m]) => m.scheme === scheme);
    if (meta && Object.hasOwn(ADDITIONAL_IDENTIFIERS_METADATA, meta[0])) cv.additional_identifiers[meta[0]] = value;
  }
  if (!cv.vat && cv.country_code) {
    // `get_tin_metadata_of_country` (odoo/tools/partner_identifiers.py:970-975): the first TIN of the country
    const tin = Object.values(TIN_METADATA).find((m) => ((m.countries ?? []) as readonly unknown[]).includes(cv.country_code));
    const vatScheme = tin?.scheme;
    if (vatScheme) {
      const v = findtext(party, `.//{*}PartyIdentification/{*}ID[@schemeID='${vatScheme}']`);
      if (v) cv.vat = v;
    }
  }

  // :2186-2187 -> account_edi_common.py:1349-1362 -> account partner.py:1109-1160 `_import_retrieve_customer` with the
  // plan of :2171-2181
  const ancestors = await companyAncestors(env, company);
  const logs: string[] = [];
  let customer: { id: number; vat: string | null } | null = await retrieveCustomer(env, cv, ancestors, accountNumbers.filter((n): n is string => Boolean(n)));
  if (customer) to["partner_id"] = customer.id;
  // :2189-2190 -> account_edi_common.py:1400-1427 `_import_create_missing_customer`: with a name and a VAT, a found
  // partner whose VAT matches stays (:1386-1398; CH normalizes otherwise: refused), one without a VAT gets it (not
  // ported), else a partner is created (:1429-1460)
  if (cv.name && cv.vat) {
    if (cv.country_code === "CH") throw new NotPorted("a Swiss VAT (_check_customer_vat_match normalization)");
    let mismatch = false;
    if (customer) {
      if (!customer.vat) throw new NotPorted("writing the VAT on the found partner (_run_vat_checks)");
      mismatch = customer.vat.replace(/ /g, "").toUpperCase() !== cv.vat.replace(/ /g, "").replace(/\./g, "").toUpperCase();
    }
    if (!customer || mismatch) {
      const id = await createMissingCustomer(env, cv);
      logs.push(mismatch
        ? translate(env, "Could not retrieve a partner corresponding to '%s' with the same VAT. A new partner was created.", "account_edi_ubl_cii").replace("%s", cv.name)
        : translate(env, "Could not retrieve a partner corresponding to '%s'. A new partner was created.", "account_edi_ubl_cii").replace("%s", cv.name));
      customer = { id, vat: cv.vat };
      to["partner_id"] = id;
    }
  }
  if (!customer) throw new NotPorted("a UBL supplier neither found nor created (a bill without partner)");

  // :2200-2212 issue and due dates
  const issue = findtext(tree, "./{*}IssueDate");
  if (issue) to["invoice_date"] = isoDate(issue);
  const due = findtext(tree, "./{*}DueDate") || findtext(tree, "./{*}PaymentMeans/{*}PaymentDueDate");
  if (due) to["invoice_date_due"] = isoDate(due);

  // :2192-2198 -> account_edi_common.py:1462-1491 `_import_invoice_add_currency`
  const companyCurrency = (await env.cr.query<{ id: number; name: string; rounding: string }>(
    "SELECT cu.id, cu.name, cu.rounding::text FROM res_company c JOIN res_currency cu ON cu.id = c.currency_id WHERE c.id = $1", [company])).rows[0]!;
  let currency: Currency = { id: companyCurrency.id, name: companyCurrency.name, rounding: Number(companyCurrency.rounding) };
  const code = findtext(tree, ".//{*}DocumentCurrencyCode");
  if (code) {
    const found = (await env.cr.query<{ id: number; name: string; active: boolean; rounding: string }>(
      "SELECT id, name, active, rounding::text FROM res_currency WHERE name = $1 ORDER BY active DESC, name LIMIT 1", [code])).rows[0];
    if (found) {
      if (!found.active) logs.push(translate(env, "The currency '%s' is not active.", "account_edi_ubl_cii").replace("%s", found.name));
      currency = { id: found.id, name: found.name, rounding: Number(found.rounding) };
    } else {
      // :1475-1479 logs "Could not retrieve currency" but keeps the empty search result, on which
      // `_get_conversion_rate` raises "Expected singleton: res.currency()": the import rolls back and posts the error
      // (account_document_import_mixin.py:338-353, measured in vagb_move_ubl_open). Not ported.
      throw new NotPorted(`an unknown currency in a UBL file (${code}: Odoo's import fails with Expected singleton)`);
    }
  }
  // :1483-1489 the conversion rate of the invoice date is only used by the base lines (src: the zero-amount filter
  // works in the document's currency, so it is not needed here); the write converts with the move's own rate
  to["currency_id"] = currency.id;
  // :2220-2221 -> account_edi_common.py:1493-1521 `_import_retrieve_partner_bank`: on a vendor bill the supplier's
  // account, found or created (base res_partner_bank.py:214-251), the trusted one first
  const banks: { id: number; trusted: boolean }[] = [];
  for (const number of accountNumbers) {
    const found = await findOrCreateBankAccount(env, number!, customer.id, company);
    if (found !== null) banks.push(found);
  }
  if (banks.length) to["partner_bank_id"] = [...banks].sort((a, b) => Number(!a.trusted) - Number(!b.trusted))[0]!.id;

  // :2223-2230 the reference
  const ref = findtext(tree, "./{*}ID");
  if (ref) to["ref"] = ref;

  // :2232-2247 the order reference, else purchase order names in the item descriptions (purchase installed)
  let invoiceOrigin: string | null = findtext(tree, "./{*}OrderReference/{*}ID");
  if (!invoiceOrigin) {
    const sequences = (await env.cr.query<{ prefix: string | null; suffix: string | null; padding: number }>(
      "SELECT prefix, suffix, padding FROM ir_sequence WHERE code = 'purchase.order' AND active AND (company_id = $1 OR company_id IS NULL)", [company])).rows;
    if (sequences.length > 1) throw new NotPorted("several purchase order sequences (the order by company)");
    if (sequences.length) {
      const s = sequences[0]!;
      const prefix = s.prefix ?? "", suffix = s.suffix ?? "";
      if (/%\(|[\\^$.|?*+()[\]{}]/.test(prefix + suffix)) throw new NotPorted("a purchase order sequence prefix or suffix with interpolation or regex characters");
      const texts = findall(tree, ".//{*}Item/{*}Description").map((d) => d.text).filter((t): t is string => Boolean(t));
      invoiceOrigin = (texts.join(" ").match(pyRegex(`${prefix}\\d{${s.padding}}${suffix}`)) ?? []).join(" ");
    }
  }
  if (invoiceOrigin) to["invoice_origin"] = invoiceOrigin;

  // :2249-2257 the notes as the narration: `<p>` of each escaped note; account_edi_ubl.py:3067
  // `_import_ubl_invoice_add_narration`, a hook: a module's override (l10n_fr_pdp: the PDP codes stripped) refuses
  if (await priv.account_edi_xml_ubl_bis3._import_ubl_invoice_add_narration.overridden(env)) throw new NotPorted("the narration of a BIS 3 import with a module's _import_ubl_invoice_add_narration");
  const notes = [...findall(tree, "./{*}Note"), ...findall(tree, "./{*}PaymentTerms/{*}Note")].map((n) => n.text).filter((t): t is string => Boolean(t));
  if (notes.some((n) => /[&<>"'\r\n]/.test(n))) throw new NotPorted("a note with markup characters or line breaks (escape and the narration's sanitizer)");
  const narration = notes.map((n) => `<p>${markupEscape(n)}</p>`).join("");
  if (narration) to["narration"] = narration;

  // :2259-2267 the payment references, unique, joined by commas
  const paymentRefs = [...new Set(findall(tree, "./{*}PaymentMeans/{*}PaymentID").map((n) => n.text).filter((t): t is string => Boolean(t)))];
  if (paymentRefs.length) to["payment_reference"] = paymentRefs.join(",");

  // :2269-2273 the delivery date
  const deliveryDate = findtext(tree, ".//{*}Delivery/{*}ActualDeliveryDate");
  if (deliveryDate) to["delivery_date"] = isoDate(deliveryDate);

  // :2928-2950 the optional fields: Studio fields x_studio_peppol_* (account_edi_ubl_cii tools/ubl_20_optional_fields.py)
  for (const model of ["account.move", "account.move.line"]) {
    if ([...env.reg.model(model).fields.keys()].some((f) => f.startsWith("x_studio_peppol_"))) throw new NotPorted(`the Peppol optional fields of ${model}`);
  }

  // :2275-2294 incoterms
  if (findall(tree, "./{*}TransportExecutionTerms/{*}DeliveryTerms/{*}ID").some((n) => n.text)) throw new NotPorted("an incoterm in a UBL file");

  // :2296-2307 a prepaid amount (its log)
  const prepaid = sign * pyFloat(findtext(tree, "./{*}LegalMonetaryTotal/{*}PrepaidAmount") || "0");
  if (!isZero(currency, prepaid)) throw new NotPorted("a prepaid amount (the log 'A payment of ... was detected')");

  // :2309-2348 the tax totals by category and percentage
  const vatDisabled = Boolean((await env.cr.query<{ v: boolean | null }>("SELECT vat_disabled AS v FROM res_company WHERE id = $1", [company])).rows[0]?.v);
  const totals = new Map<string, TaxTotal>();
  for (const sub of findall(tree, "./{*}TaxTotal/{*}TaxSubtotal")) {
    const amountNode = find(sub, ".//{*}TaxAmount");
    const category = findtext(sub, ".//{*}TaxCategory/{*}ID");
    if (amountNode === null || category === null) continue;
    const cur = amountNode.attrib.get("currencyID");
    if (cur && cur !== currency.name) continue;
    let percentage: string | number | null = findtext(sub, ".//{*}TaxCategory/{*}Percent");
    if (percentage === null) percentage = findtext(sub, ".//{*}Percent");
    if (vatDisabled && percentage === null && category === "O") percentage = 0;
    if (percentage === null) continue;
    const pct = typeof percentage === "number" ? percentage : pyFloat(percentage);
    const key = JSON.stringify([category, pct]);
    const t = totals.get(key) ?? { amountType: "percent" as const, typeTaxUse: documentType, amount: pct, code: category, taxAmount: 0, related: [] };
    totals.set(key, t);
    t.taxAmount += sign * pyFloat(amountNode.text ?? "");
  }

  // the tax values of a TaxCategory node, from the tax totals (:2749-2774)
  const classified = (cat: Element): TaxValues | null => {
    let pct: string | number | null = findtext(cat, "./{*}Percent");
    const cc = findtext(cat, "./{*}ID");
    if (vatDisabled && cc === "O" && pct === null) pct = 0;
    if (pct === null || cc === null) return null;
    const amount = typeof pct === "number" ? pct : pyFloat(pct);
    const key = JSON.stringify([cc, amount]);
    const total = totals.get(key);
    return total ? { amount: total.amount, code: total.code, key } : null;
  };
  const charging = (indicator: string | null): boolean => {
    if (indicator === null) throw new NotPorted("an allowance or charge without ChargeIndicator (Odoo's import fails)");
    return indicator.toLowerCase() === "true";
  };

  // :2350-2414 document allowances and charges with a tax percentage (the others are skipped): their tax from the
  // tax totals, and an attempt at a tax of their own category (`taxes_values` of the document, :1643-1722)
  const docCharges: DocAllowance[] = [], docAllowances: DocAllowance[] = [], attempts: TaxValues[] = [];
  for (const el of findall(tree, "./{*}AllowanceCharge")) {
    const amountStr = findtext(el, "./{*}Amount"), baseStr = findtext(el, "./{*}BaseAmount"), mult = findtext(el, "./{*}MultiplierFactorNumeric");
    const pctStr = findtext(el, "./{*}TaxCategory/{*}Percent"), code = findtext(el, "./{*}TaxCategory/{*}ID");
    if (!pctStr) continue;
    const a: DocAllowance = {
      amount: amountStr ? pyFloat(amountStr) : 0, base: baseStr ? pyFloat(baseStr) : null, multiplier: mult ? pyFloat(mult) : null,
      reason: findtext(el, "./{*}AllowanceChargeReason"), charge: charging(findtext(el, "./{*}ChargeIndicator")), taxes: null,
    };
    const catNode = find(el, "./{*}TaxCategory");
    const tv = catNode ? classified(catNode) : null;
    if (tv) { a.taxes = tv; totals.get(tv.key)!.related.push(tv); }
    (a.charge ? docCharges : docAllowances).push(a);
    if (!code) continue;
    attempts.push({ amount: pyFloat(pctStr), code, key: JSON.stringify([code, pyFloat(pctStr)]) });
  }

  // :2840-2868 the invoice lines
  if (findall(tree, "./{*}CreditNoteLine").length || findall(tree, "./{*}DebitNoteLine").length) throw new NotPorted("credit or debit note lines");
  const lines: LineValues[] = [];
  for (const line of findall(tree, "./{*}InvoiceLine")) {
    // :2437-2484 allowances and charges of the line (with an amount), and of its price
    const allowances: number[] = [], charges: number[] = [];
    for (const el of findall(line, "./{*}AllowanceCharge")) {
      const amountStr = findtext(el, ".//{*}Amount");
      if (!amountStr) continue;
      const isCharge = charging(findtext(el, ".//{*}ChargeIndicator"));
      // :2776-2790 a charge with reason code AEO tries a fixed tax of its amount per unit (search_fixed_tax_fuzzy)
      if (isCharge && findtext(el, ".//{*}AllowanceChargeReasonCode") === "AEO") throw new NotPorted("a line charge with reason AEO (a fixed tax)");
      (isCharge ? charges : allowances).push(pyFloat(amountStr));
    }
    const priceEl = find(line, "./{*}Price/{*}AllowanceCharge");
    let priceAllowanceBase: number | null = null, priceAllowanceAmount: number | null = null;
    if (priceEl !== null) {
      const sign = (findtext(priceEl, "./{*}ChargeIndicator") || "false").toLowerCase() === "true" ? 1 : -1;
      const amountStr = findtext(priceEl, "./{*}Amount"), baseStr = findtext(priceEl, "./{*}BaseAmount");
      priceAllowanceAmount = amountStr ? pyFloat(amountStr) : null;
      priceAllowanceBase = baseStr ? pyFloat(baseStr) : null;
      if (priceAllowanceAmount) priceAllowanceAmount *= sign;
    }
    // :2416-2435 the name: the item name and its descriptions
    const itemName = findtext(line, ".//{*}Item/{*}Name");
    const description = findall(line, ".//{*}Item/{*}Description").map((d) => d.text).filter((t): t is string => Boolean(t)).join("\n");
    const lineName = [itemName, description].filter((x): x is string => Boolean(x)).join("\n");
    // :2486-2603 price, quantity and discount
    const num = (s: string | null): number | null => {
      if (s === null) return null;
      if (s === "") throw new NotPorted("an empty amount or quantity in a UBL line");
      return pyFloat(s);
    };
    const lineExtension = ((v) => (v === null ? null : v * sign))(num(findtext(line, ".//{*}LineExtensionAmount")));
    const priceAmount = num(findtext(line, ".//{*}Price/{*}PriceAmount"));
    const invoicedQuantity = ((v) => (v === null ? null : v * sign))(num(findtext(line, ".//{*}InvoicedQuantity") || findtext(line, ".//{*}CreditedQuantity") || null));
    const baseQuantity = num(findtext(line, "./{*}Price/{*}BaseQuantity"));
    const totalAllowances = allowances.reduce((x, y) => x + y, 0);
    const totalCharges = charges.reduce((x, y) => x + y, 0);
    const subtotal = (lineExtension || 0) + totalAllowances - totalCharges;
    let priceQuantity: number, priceSubtotal: number, priceDiscount: number;
    if (priceAmount) {
      priceQuantity = baseQuantity || 1;
      if (priceAllowanceBase) {
        priceDiscount = priceAllowanceBase - priceAmount;
        priceSubtotal = priceAllowanceBase;
      } else if (priceAllowanceAmount) {
        priceDiscount = -priceAllowanceAmount;
        priceSubtotal = priceAmount - priceAllowanceAmount;
      } else {
        priceDiscount = 0;
        priceSubtotal = priceAmount;
      }
    } else if (priceAllowanceBase) {
      priceSubtotal = priceAllowanceBase;
      priceQuantity = baseQuantity || 1;
      priceDiscount = -(priceAllowanceAmount || 0);
    } else {
      priceSubtotal = 0;
      priceQuantity = 0;
      priceDiscount = 0;
    }
    const div = (a: number, b: number): number => {
      if (b === 0) throw new NotPorted("a UBL line whose amounts divide by zero (Odoo's import fails)");
      return a / b;
    };
    let quantity: number, priceUnit: number | null, discountAmount: number;
    if (lineExtension !== null && !invoicedQuantity) {
      priceUnit = subtotal;
      quantity = 1;
      discountAmount = totalAllowances;
      if (!isZero(currency, priceSubtotal)) {
        quantity = div(subtotal * priceQuantity, priceSubtotal - priceDiscount);
        priceUnit = quantity ? subtotal / quantity + div(priceDiscount, priceQuantity) : priceAmount;
        discountAmount += div(priceDiscount * quantity, priceQuantity);
      }
    } else if (lineExtension !== null && invoicedQuantity) {
      quantity = invoicedQuantity;
      priceUnit = subtotal / quantity;
      discountAmount = totalAllowances;
      if (!isZero(currency, priceSubtotal)) {
        priceUnit = div(priceSubtotal, priceQuantity);
        discountAmount += div(priceDiscount * quantity, priceQuantity);
      }
    } else {
      quantity = 0;
      priceUnit = 0;
      discountAmount = totalAllowances;
      if (!isZero(currency, priceSubtotal)) {
        priceUnit = div(priceSubtotal, priceQuantity);
        quantity = priceQuantity;
        discountAmount += priceDiscount;
      }
    }
    if (priceUnit === null) throw new NotPorted("a UBL line without a price (price_unit None)");
    priceUnit += totalCharges / (quantity || 1);
    const gross = priceUnit * quantity;
    const discount = gross ? (discountAmount * 100) / gross : 0;
    // :2735-2747 deferred dates: account_accountant is not installed
    // :2688-2719 the product values: identifiers and classification codes refuse (supplier info, barcode, code)
    if (findtext(line, ".//{*}Item/{*}SellersItemIdentification/{*}ID") || findtext(line, ".//{*}Item/{*}BuyersItemIdentification/{*}ID")
      || findtext(line, `.//{*}Item/{*}StandardItemIdentification/{*}ID[@schemeID="0160"]`)) {
      throw new NotPorted("item identifiers in a UBL line (product search by supplier info, barcode or code)");
    }
    const classifiedCodes = findall(line, "./{*}Item/{*}CommodityClassification/{*}ItemClassificationCode")
      .some((c) => ["HS", "TST", "STI", "CG"].includes(c.attrib.get("listID") ?? "") && c.text);
    if (classifiedCodes) {
      const product = env.reg.model("product.product").fields;
      if (["intrastat_code_id", "unspsc_code_id", "cpv_code_id", "l10n_hr_kpd_category_id"].some((f) => product.has(f))) throw new NotPorted("item classification codes for the product search");
    }
    // :2721-2730 the unit's UN/ECE code
    const qtyNode = find(line, ".//{*}InvoicedQuantity") ?? find(line, ".//{*}CreditedQuantity");
    const uomCode = qtyNode?.attrib.get("unitCode") || null;
    // :2605-2686 vehicles (VIN, plates): any found refuses
    if (vehicleValues(tree, line)) throw new NotPorted("vehicle identifiers in a UBL line (_import_vehicle)");
    // :2792-2809 the line's percentage taxes, from the tax totals (:2749-2774)
    const taxes: TaxValues[] = [];
    for (const cat of findall(line, ".//{*}Item/{*}ClassifiedTaxCategory")) {
      const tv = classified(cat);
      if (!tv) continue;
      taxes.push(tv);
      totals.get(tv.key)!.related.push(tv);
    }
    lines.push({ name: lineName, productName: itemName, quantity, priceUnit, discount, uomCode, taxes });
  }

  // :2873-2874 -> account_edi_common.py:1523-1552: predictions need account_accountant (not installed)

  // :2876-2877 -> account_edi_common.py:1558-1584 -> account product.py:571-668: by name only here (the identifiers
  // refused above): `name ilike` candidates under the static domain, then a similarity of 90 % (product.py:526-568);
  // a candidate refuses
  for (const l of lines) {
    if (!l.productName) continue;
    const escaped = l.productName.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const found = (await env.cr.query(
      `SELECT p.id FROM product_product p JOIN product_template t ON t.id = p.product_tmpl_id
        WHERE p.active AND COALESCE(t.name->>$1, t.name->>'en_US') ILIKE $2 AND (t.company_id IS NULL OR t.company_id = ANY($3::int[])) LIMIT 1`,
      [env.lang ?? "en_US", `%${escaped}%`, ancestors])).rows;
    if (found.length) throw new NotPorted("a product the line name finds (the name similarity of _import_retrieve_product_from_name)");
  }

  // :2879-2880 -> account_edi_common.py:1586-1618: the unit by UN/ECE code (account_edi_ubl_cii uom_uom.py:45-47,
  // account uom_uom.py:53-56); no product, so no compatibility check
  for (const l of lines) {
    if (!l.uomCode) continue;
    const byCode = (await env.cr.query<{ id: number }>("SELECT id FROM uom_uom WHERE unece_code = $1 ORDER BY sequence, id", [l.uomCode.toUpperCase()])).rows;
    if (byCode.length > 1) throw new NotPorted("several units for a UN/ECE code (the order by relative unit)");
    let uom = byCode[0]?.id ?? null;
    if (uom === null) {
      const xml = UNECE_TO_UOM[l.uomCode.toUpperCase()] ?? "uom.product_uom_unit";
      const [module, nm] = xml.split(".") as [string, string];
      uom = (await env.cr.query<{ id: number }>("SELECT res_id AS id FROM ir_model_data WHERE module = $1 AND name = $2 AND model = 'uom.uom'", [module, nm])).rows[0]?.id ?? null;
    }
    if (uom !== null) l.uom = uom;
  }

  // :2870-2871 -> account_edi_common.py:1643-1722 -> account account_tax.py:5107-5179 `_import_retrieve_tax` with the
  // plan :1634-1641; without an account or predictions only `_import_retrieve_tax_from_price_include_exclude`
  // (:5037-5058) gives criteria; the fiscal position of a new move of the supplier (account_move.py:1080-1094)
  const delivery = (await addressGet(env, customer.id, ["delivery"]))["delivery"] ?? null;
  const fpos = await fiscalPositionFor(env, company, customer.id, delivery);
  const fposDomestic = fpos === null ? false : Boolean((await env.cr.query<{ d: boolean | null }>("SELECT is_domestic AS d FROM account_fiscal_position WHERE id = $1", [fpos])).rows[0]?.d);
  const cache = new Map<string, number | null>();
  // `tax_values_list`: the document's attempts, the lines' taxes, the document allowances' taxes (:1647-1660)
  const toRetrieve: { tv: TaxValues; line: boolean }[] = [
    ...attempts.map((tv) => ({ tv, line: false })), ...lines.flatMap((l) => l.taxes.map((tv) => ({ tv, line: true }))),
    ...[...docAllowances, ...docCharges].filter((a) => a.taxes).map((a) => ({ tv: a.taxes!, line: false })),
  ];
  for (const { tv, line } of toRetrieve) {
    {
      const codes = [tv.code, ...(vatDisabled && tv.code !== "O" ? ["O"] : [])];
      const byAmount = tv.amount || tv.code !== "AE" ? "t.amount = $4" : "t.ubl_cii_tax_category_code = 'AE'";
      // `price_include` (account_tax.py:307-318 `_search_price_include`): False is the 'tax_excluded' side
      const included = (incl: boolean): string => {
        const v = incl ? "tax_included" : "tax_excluded";
        return `(t.price_include_override = '${v}' OR (t.price_include_override IS NULL AND c.account_price_include = '${v}'))`;
      };
      const fposSql = fpos === null ? "" : ` AND (EXISTS (SELECT 1 FROM account_fiscal_position_account_tax_rel r WHERE r.account_tax_id = t.id AND r.account_fiscal_position_id = ${Number(fpos)})${fposDomestic ? " OR NOT EXISTS (SELECT 1 FROM account_fiscal_position_account_tax_rel r WHERE r.account_tax_id = t.id)" : ""})`;
      const criteria = [
        ...(fpos !== null ? [included(false) + fposSql] : []), included(false),
        ...(fpos !== null ? [included(true) + fposSql] : []), included(true),
      ];
      for (const crit of criteria) {
        const key = `${tv.code}|${tv.amount}|${crit}`;
        let tax = cache.get(key);
        if (tax === undefined) {
          tax = (await env.cr.query<{ id: number }>(
            `SELECT t.id FROM account_tax t JOIN res_company c ON c.id = t.company_id
              WHERE t.active AND t.company_id = ANY($1::int[]) AND t.amount_type = 'percent' AND t.type_tax_use = $2
                AND (t.ubl_cii_tax_category_code = ANY($3::text[]) OR t.ubl_cii_tax_category_code IS NULL) AND ${byAmount}
                AND (t.price_include_override IS NULL OR t.price_include_override = 'tax_excluded') AND ${crit}
              ORDER BY t.ubl_cii_tax_category_code, t.sequence, t.id LIMIT 1`,
            [ancestors, documentType, codes, tv.amount])).rows[0]?.id ?? null;
          cache.set(key, tax);
        }
        if (tax !== null) { tv.tax = tax; break; }
      }
      // :1693-1722 a tax not found logs (on the line, or for the document's allowance or charge): not ported
      if (!tv.tax) throw new NotPorted(`a UBL tax the import does not find (the log 'Could not retrieve the tax'${line ? "" : " for the document level allowance/charge"})`);
    }
  }
  // :1676-1679 the document's attempts join the related taxes of their tax total
  for (const tv of attempts) totals.get(tv.key)?.related.push(tv);
  const lineTaxes = await env.cr.query<{ id: number; incl: boolean }>(
    `SELECT t.id, (t.price_include_override = 'tax_included' OR (t.price_include_override IS NULL AND c.account_price_include = 'tax_included')) AS incl
       FROM account_tax t JOIN res_company c ON c.id = t.company_id WHERE t.id = ANY($1::int[])`, [toRetrieve.map((r) => r.tv.tax!)]);
  if (lineTaxes.rows.some((r) => r.incl)) throw new NotPorted("a price-included tax on an imported line");

  // :2919-2920 -> account_edi_common.py:1820-1879: base lines; a line whose total is zero (and without discount) is
  // dropped: refused here
  // :1745-1773 the document's charges, then its allowances, as lines before the products: the base amount times the
  // multiplier, else the amount, signed (a charge positive); the reason as name, the allowance's tax
  const docLines: { name: string; quantity: number; priceUnit: number; taxes: TaxValues[] }[] = [];
  for (const a of [...docCharges, ...docAllowances]) {
    const chargeSign = a.charge ? 1 : -1;
    let priceUnit: number, quantity: number;
    if (a.base) {
      if (a.multiplier === null) throw new NotPorted("a document allowance with a base amount and no multiplier (Odoo's import fails)");
      priceUnit = a.base * chargeSign * sign;
      quantity = a.multiplier / 100;
    } else {
      priceUnit = a.amount * chargeSign * sign;
      quantity = 1;
    }
    if (a.reason === null) throw new NotPorted("a document allowance or charge without a reason (a line named False)");
    docLines.push({ name: a.reason, quantity, priceUnit, taxes: a.taxes ? [a.taxes] : [] });
  }
  for (const l of [...docLines, ...lines.map((x) => ({ ...x, taxes: x.taxes }))]) {
    const disc = "discount" in l ? (l as LineValues).discount : 0;
    const base = l.priceUnit * l.quantity * (1 - disc / 100);
    const total = base * (1 + l.taxes.reduce((s, t) => s + t.amount, 0) / 100);
    if (isZero(currency, total) && !disc) throw new NotPorted("a UBL line of zero amount (dropped by the import)");
  }
  // account account_move.py:5082-5090 `_disable_discount_precision`: during the write the discount keeps 13 digits and
  // the quantity 10 (decimal_precision.py:7-15); a value the usual precision would round refuses (the port rounds)
  const digits = new Map((await env.cr.query<{ name: string; digits: number }>("SELECT name, digits FROM decimal_precision WHERE name IN ('Discount', 'Product Unit')")).rows.map((r) => [r.name, r.digits]));
  const keeps = (v: number, name: string): boolean => floatRound(v, digits.get(name) ?? 2) === v;
  for (const l of [...docLines.map((d) => ({ quantity: d.quantity, discount: 0 })), ...lines]) {
    if (!keeps(l.quantity, "Product Unit") || !keeps(l.discount, "Discount")) throw new NotPorted("an imported quantity or discount beyond the usual precision (ignore_discount_precision)");
  }

  // :2922-2923 -> account_edi_common.py:1881-1910: one write with the lines, under `_check_balanced`,
  // `_disable_discount_precision` and `_sync_dynamic_lines` (the write of account.move does them, src/models/account_move_create.ts)
  to["invoice_line_ids"] = [
    ...docLines.map((d) => [0, 0, { name: d.name, quantity: d.quantity, price_unit: d.priceUnit, discount: 0, tax_ids: [[6, 0, d.taxes.map((t) => t.tax!)]] }]),
    ...lines.map((l) => [0, 0, {
      ...(l.name ? { name: l.name } : {}),
      quantity: l.quantity, price_unit: l.priceUnit, discount: l.discount,
      tax_ids: [[6, 0, l.taxes.map((t) => t.tax!)]],
      ...(l.uom !== undefined ? { product_uom_id: l.uom } : {}),
    }]),
  ];
  // the tracking is logged at the commit that ends the decoder (`rollbackable_transaction`), after the import's
  // message (measured: "Format used ..." then the tracking): one scope around the decoder (src/mail/write_hooks.ts)
  await trackPrepare(env, "account.move", [moveId]);
  await ormWrite(env, "account.move", [moveId], to);

  // :2925-2926 -> account_edi_common.py:1912-1995 `_import_invoice_fix_taxes_amounts`: complete totals within 0.03 of
  // the bill's tax are distributed on the tax lines; a delta of zero rewrites them unchanged (nothing to do here)
  const amounts = (await env.cr.query<{ amount_tax: string; amount_untaxed: string }>("SELECT amount_tax::text, amount_untaxed::text FROM account_move WHERE id = $1", [moveId])).rows[0]!;
  const totalTax = [...totals.values()].reduce((s, t) => s + t.taxAmount, 0);
  const complete = [...totals.values()].every((t) => t.related.every((r) => r.tax));
  const cmp = (a: number, b: number): number => (isZero(currency, a - b) ? 0 : a < b ? -1 : 1);
  if (complete && cmp(Math.abs(Number(amounts.amount_tax) - totalTax) - 0.03, 0) <= 0) {
    for (const t of totals.values()) {
      const taxes = [...new Set(t.related.map((r) => r.tax!))];
      if (!taxes.length) continue;
      if (taxes.length > 1) throw new NotPorted("several taxes for one UBL tax subtotal (their distribution)");
      const computed = (await env.cr.query<{ s: string | null }>(
        "SELECT sum(amount_currency)::text AS s FROM account_move_line WHERE move_id = $1 AND tax_line_id = $2", [moveId, taxes[0]])).rows[0]?.s;
      if (!isZero(currency, t.taxAmount - Number(computed ?? 0))) throw new NotPorted("a UBL tax amount that differs from the computed one (_distribute_delta_amount_smoothly)");
    }
  }

  // :2952-2991 `_import_ubl_invoice_fix_untaxed_amount`: a difference adds a "Rounding" line
  const exclusive = findtext(tree, "./{*}LegalMonetaryTotal/{*}TaxExclusiveAmount");
  if (exclusive) {
    const rounding = findtext(tree, "./{*}LegalMonetaryTotal/{*}PayableRoundingAmount");
    const expected = sign * pyFloat(exclusive) + sign * pyFloat(rounding || "0");
    if (!isZero(currency, roundCur(currency, expected - Number(amounts.amount_untaxed)))) throw new NotPorted("a UBL untaxed amount that differs from the lines (the Rounding line)");
  }

  // :3035-3036 -> account_edi_common.py:1997-2022 `_import_invoice_post_processing`: the file becomes the bill's
  // `ubl_cii_xml_file` (ir_attachment.py:878-897 write: write access on the bill; account ir_attachment.py:39-53: no
  // audit trail on a draft never posted)
  if (!(await permissionOn(env, "account.move", moveId, "write"))) throw new NotPorted("the UBL file of a bill the user cannot write");
  await env.cr.query(`UPDATE ir_attachment SET res_field = 'ubl_cii_xml_file', res_model = 'account.move', res_id = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`,
    [attachmentId, moveId, env.uid]);
  // account_edi_ubl.py:2993-3033 `_import_attachments`: the embedded documents (common :651-688), then the substitute
  // PDF when there are none, no main attachment, a purchase document and the parameter allows it
  const docs: number[] = move.main_mimetype === "application/pdf" ? [] : await importEmbeddedDocuments(env, moveId, tree, move.main);
  const param = (await env.cr.query<{ v: string }>("SELECT value AS v FROM ir_config_parameter WHERE key = 'account_edi_ubl_cii.disable_pdf_in_xml'")).rows[0]?.v;
  const disablePdf = param === undefined ? false : ({ true: true, "1": true, false: false, "0": false } as Record<string, boolean>)[param.toLowerCase()];
  if (disablePdf === undefined) throw new NotPorted(`the parameter account_edi_ubl_cii.disable_pdf_in_xml = ${param}`);
  if (!docs.length && move.main === null && !disablePdf) {
    // `_render_qweb_pdf` of action_report_account_invoices_generated_by_odoo: without a PDF engine Odoo's UserError
    // ("Unable to find the pdf engine") is caught and logged (:3031-3032), as on the oracle: nothing is created
    if (hasPdfEngine(env)) docs.push(await substitutePdf(env, moveId));
  }
  // the chatter (account_edi_common.py:2015-2022): "Format used to import the invoice" with the file, then the logs,
  // unique (`dict.fromkeys`), each escaped in a `<li>`
  const modelName = (await env.cr.query<{ n: string }>("SELECT COALESCE(name->>$1, name->>'en_US') AS n FROM ir_model WHERE model = 'account.edi.xml.ubl_bis3'", [env.lang ?? "en_US"])).rows[0]?.n;
  if (!modelName) throw new NotPorted("account.edi.xml.ubl_bis3 missing from ir_model");
  const title = translate(env, "Format used to import the invoice: %s", "account_edi_ubl_cii").replace("%s", markupEscape(modelName));
  const unique = [...new Set(logs)];
  const list = unique.length ? `<ul>${unique.map((l) => `<li>${markupEscape(l)}</li>`).join("")}</ul>` : "";
  await postImportMessage(env.withContext({ ...env.context, no_new_invoice: true }), moveId, `<strong>${title}</strong>${list}`, [attachmentId, ...docs]);
  await closeTrackingScope(env, "account.move");

  // account_move.py:5025-5027: the import source (`_set_import_source_attachment`, :5009-5013: the selected file's attachment)
  await env.cr.query(`UPDATE account_move SET import_source_attachment_id = $2, write_uid = $3, write_date = now() AT TIME ZONE 'UTC' WHERE id = $1`, [moveId, attachmentId, env.uid]);
  // :5029-5036: the new lines are imported; the bill had none, so the purchase orders are looked for
  const all = (await env.cr.query<{ id: number; product: boolean }>(
    "SELECT id, display_type = 'product' AS product FROM account_move_line WHERE move_id = $1 ORDER BY id", [moveId])).rows;
  const invoiceLines = (await env.cr.query<{ id: number }>(
    "SELECT id FROM account_move_line WHERE move_id = $1 AND display_type IN ('product', 'line_section', 'line_subsection', 'line_note') ORDER BY id", [moveId])).rows.map((r) => r.id);
  await env.cr.query(`UPDATE account_move_line SET is_imported = true WHERE id = ANY($1::int[])`, [invoiceLines]);
  await env.cr.query(`UPDATE account_move_line SET write_uid = $2, write_date = now() AT TIME ZONE 'UTC' WHERE move_id = $1`, [moveId, env.uid]);
  const originCleared = await linkPurchaseOrders(env, moveId, company, customer.id);
  // :5055 -> account_edi_ubl_cii account_move.py:185-208 `_post_process_link_to_purchase_order`
  await groupLinesPostProcess(env, moveId, company, customer.id);

  // the version of the request after the commit (measured: vagb_move_ubl): the bill's import source, the lines' flag,
  // the other lines rewritten by the line write's `_sync_dynamic_lines`
  const out: Written = { "account.move": { [String(moveId)]: ["import_source_attachment_id", ...(originCleared ? ["invoice_origin"] : []), "write_date"] }, "account.move.line": {} };
  const imported = new Set(invoiceLines);
  for (const l of all) out["account.move.line"]![String(l.id)] = imported.has(l.id) ? ["is_imported", "write_date"] : ["write_date"];
  return out;
}

interface CustomerValues {
  vat: string | null; phone: string | null; name: string | null; email: string | null; country_code: string | null;
  street: string | null; street2: string | null; city: string | null; zip: string | null;
  routing_scheme: string | null; routing_endpoint: string | null; additional_identifiers: Record<string, string>;
}

type Candidate = { id: number; is_company: boolean | null; supplier_rank: number | null; vat: string | null };

/**
 * A domain criterion of account partner.py:1109-1160: `search(static & domain, order='is_company DESC, supplier_rank
 * DESC, company_id, parent_id DESC, id DESC', limit=1)` under the static domain (no company or the company and its
 * parents), active. The port orders by the first two keys and refuses a tie after them.
 */
async function searchCustomer(env: Environment, where: string, params: unknown[], ancestors: number[]): Promise<Candidate | null | "tie"> {
  const rows = (await env.cr.query<Candidate>(
    `SELECT p.id, p.is_company, p.supplier_rank, p.vat FROM res_partner p LEFT JOIN res_country c ON c.id = p.country_id
      WHERE p.active AND (p.company_id IS NULL OR p.company_id = ANY($1::int[])) AND (${where})`, [ancestors, ...params])).rows;
  if (!rows.length) return null;
  if (rows.some((c) => c.is_company === null || c.supplier_rank === null)) throw new NotPorted("partners without is_company or supplier_rank for an import criterion (NULLS FIRST)");
  rows.sort((a, b) => Number(b.is_company) - Number(a.is_company) || b.supplier_rank! - a.supplier_rank!);
  const top = rows.filter((c) => c.is_company === rows[0]!.is_company && c.supplier_rank === rows[0]!.supplier_rank);
  return top.length > 1 ? "tie" : top[0]!;
}

/**
 * account_edi_ubl.py:2171-2181 the search plan, criterion after criterion (account partner.py:956-1107,
 * account_edi_ubl_cii res_partner.py:340-350): the VAT (as written, the Swiss variants, without its prefix with the
 * country or without one, the digits by regex), the additional identifiers, the routing identifier, a trusted bank
 * account, the email, the phone, the name. The first criterion that finds a partner gives it.
 */
async function retrieveCustomer(env: Environment, cv: CustomerValues, ancestors: number[], accountNumbers: string[]): Promise<{ id: number; vat: string | null } | null> {
  const criteria: { where: string; params: unknown[] }[] = [];
  const unique = async (sql: string, params: unknown[]): Promise<Candidate | null> => {
    // the search methods: `_search(..., limit=2)`, a partner when exactly one
    const rows = (await env.cr.query<Candidate>(sql, params)).rows;
    return rows.length === 1 ? rows[0]! : null;
  };
  const plans: (() => Promise<Candidate | null | "tie">)[] = [];
  if (cv.vat) {
    const vat = cv.vat;
    const normalized = vat.replace(/ /g, "").replace(/\./g, "");
    const prefix = /^[a-zA-Z]{2}/.exec(vat)?.[0] ?? "";
    criteria.push({ where: "p.vat IN ($2, $3)", params: [normalized, vat] });
    if (prefix.toUpperCase() === "CH") throw new NotPorted("a Swiss VAT (_get_country_specific_vat_variants)");
    if (prefix) {
      criteria.push({ where: "p.vat IN ($2, $3) AND c.code = $4", params: [normalized.slice(2), vat.slice(2), prefix.toUpperCase()] });
      criteria.push({ where: "p.vat IN ($2, $3) AND p.country_id IS NULL", params: [normalized.slice(2), vat.slice(2)] });
    }
    for (const c of criteria) plans.push(() => searchCustomer(env, c.where, c.params, ancestors));
    // `str(int(re.sub(r'^\D{2}', '', normalized_vat) or 0))`
    const rest = normalized.replace(/^\D{2}/u, "");
    const numeric = rest === "" ? "0" : /^\d+$/.test(rest) ? String(BigInt(rest)) : null;
    if (numeric) {
      const re = `^${prefix ? `(${prefix})?` : "([A-z]{2})?"}0*${numeric}$`;
      plans.push(() => unique(`SELECT id, is_company, supplier_rank, vat FROM res_partner WHERE active AND (company_id IS NULL OR company_id = ANY($1::int[])) AND vat ~ $2 LIMIT 2`, [ancestors, re]));
    }
  }
  const ids = Object.entries(cv.additional_identifiers).filter(([, v]) => v && !["/", "na", "NA", "N/A", "not applicable"].includes(v));
  if (ids.length) {
    // partner.py:1082-1107: active only (no static domain), one of the identifiers
    const conds = ids.map((_e, i) => `additional_identifiers @> $${i + 1}::jsonb`).join(" OR ");
    plans.push(() => unique(`SELECT id, is_company, supplier_rank, vat FROM res_partner WHERE active AND (${conds}) LIMIT 2`, ids.map(([k, v]) => JSON.stringify({ [k]: v }))));
  }
  if (cv.routing_scheme && cv.routing_endpoint) {
    plans.push(() => searchCustomer(env, "p.routing_scheme = $2 AND p.routing_endpoint = $3", [cv.routing_scheme, cv.routing_endpoint], ancestors));
  }
  if (accountNumbers.length) {
    // partner.py:1018-1044: trusted active accounts with those (sanitized) numbers the company may use
    const sanitized = accountNumbers.map((n) => n.replace(/[^\p{L}\p{N}_]+/gu, "").toUpperCase());
    plans.push(() => searchCustomer(env, `EXISTS (SELECT 1 FROM res_partner_bank b WHERE b.partner_id = p.id AND b.active AND b.allow_out_payment
      AND b.sanitized_account_number = ANY($2::text[]) AND (b.company_id IS NULL OR b.company_id = ANY($1::int[])))`, [sanitized], ancestors));
  }
  if (cv.email) plans.push(() => searchCustomer(env, "p.email = $2", [cv.email], ancestors));
  if (cv.phone) plans.push(() => searchCustomer(env, "p.phone = $2", [cv.phone], ancestors));
  // `=ilike`: the name as a pattern, without wildcards added
  if (cv.name) plans.push(() => searchCustomer(env, "p.name ILIKE $2", [cv.name], ancestors));
  for (const plan of plans) {
    const found = await plan();
    if (found === "tie") throw new NotPorted("several partners for an import criterion (the order by company and parent)");
    if (found) {
      // the record rules: the user reads the partner (res_partner_rule)
      if (!(await env.model("res.partner").search(cond("id", "=", found.id))).length) throw new NotPorted("a supplier the user cannot read");
      return { id: found.id, vat: found.vat };
    }
  }
  return null;
}

/**
 * account_edi_common.py:1429-1460 `_import_prepare_missing_customer_create_values` and `res.partner.create`: a company
 * with the file's contact and address, its routing identifier, its country (`base.<code>`, GB as uk) and its VAT
 * through `_run_vat_checks(validation='setnull')`. Additional identifiers (their validators) refuse; an invalid
 * routing endpoint makes Odoo's create raise (the import's error message): refused.
 */
async function createMissingCustomer(env: Environment, cv: CustomerValues): Promise<number> {
  const vals: Record<string, unknown> = { is_company: true };
  for (const key of ["phone", "name", "email", "street", "street2", "zip", "city", "routing_scheme", "routing_endpoint"] as const) {
    if (cv[key]) vals[key] = cv[key];
  }
  // :1440-1448 the additional identifiers that validate (`_validate_identifier`, base res_partner.py:1545-1586), as
  // written in the file
  const valid: Record<string, string> = {};
  for (const [key, value] of Object.entries(cv.additional_identifiers)) {
    const v = value.trim();
    if (!v || ["/", "na", "NA", "N/A", "not applicable"].includes(value)) { valid[key] = value; continue; }
    const validator = IDENTIFIER_VALIDATORS[key];
    if (!validator) throw new NotPorted(`the validation of a new UBL supplier's ${key}`);
    if (validator(v) !== null) valid[key] = value;
  }
  if (Object.keys(valid).length) vals["additional_identifiers"] = valid;
  let countryCode: string | null = null;
  if (cv.country_code) {
    const ref = cv.country_code === "GB" ? "uk" : cv.country_code.toLowerCase();
    const row = (await env.cr.query<{ id: number; code: string }>(
      `SELECT c.id, c.code FROM ir_model_data d JOIN res_country c ON c.id = d.res_id WHERE d.module = 'base' AND d.name = $1 AND d.model = 'res.country'`, [ref])).rows[0];
    if (row) { vals["country_id"] = row.id; countryCode = row.code; }
  }
  if (cv.vat) {
    if (!countryCode) vals["vat"] = cv.vat;
    else {
      try {
        vals["vat"] = await runVatChecks(env, countryCode, cv.vat, "error");
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        vals["vat"] = ""; // validation='setnull'
      }
    }
  }
  try {
    const [id] = await ormCreate(env, "res.partner", [vals]);
    return id!;
  } catch (e) {
    if (e instanceof ValidationError) throw new NotPorted(`a new UBL supplier Odoo's create rejects (${e.message})`);
    throw e;
  }
}

/**
 * base res_partner_bank.py:214-251 `_find_or_create_bank_account(account_number, partner, company)`:
 *  - the accounts of the partner's commercial entity and its children with that number (`account_number` searches the
 *    sanitized number, :148-156), archived ones too, as superuser;
 *  - none: a company's own partner refuses (Odoo's UserError, which the import logs: not ported), else the account is
 *    created as the user, untrusted (account res_partner_bank.py:333-357, src/models/partner_bank_create.ts);
 *  - of those, the active ones the company may use (no company, or the company and its parents), the partner's own
 *    first (a stable sort on `partner_id != partner`); none: null.
 */
async function findOrCreateBankAccount(env: Environment, number: string, partner: number, company: number): Promise<{ id: number; trusted: boolean } | null> {
  const sanitized = number.replace(/[^\p{L}\p{N}_]+/gu, "").toUpperCase();
  const commercial = (await env.cr.query<{ c: number | null }>("SELECT commercial_partner_id AS c FROM res_partner WHERE id = $1", [partner])).rows[0]?.c ?? partner;
  const childOf = `WITH RECURSIVE tree(id) AS (SELECT $1::int UNION SELECT p.id FROM res_partner p JOIN tree ON p.parent_id = tree.id)`;
  // `search` of res.partner.bank: its order `sequence, id` (base res_partner_bank.py:16)
  let rows = (await env.cr.query<{ id: number; partner_id: number; active: boolean | null; company_id: number | null; trusted: boolean | null }>(
    `${childOf} SELECT b.id, b.partner_id, b.active, b.company_id, b.allow_out_payment AS trusted FROM res_partner_bank b
      WHERE b.sanitized_account_number = $2 AND b.partner_id IN (SELECT id FROM tree) ORDER BY b.sequence, b.id`, [commercial, sanitized])).rows;
  if (!rows.length) {
    if ((await env.cr.query("SELECT 1 FROM res_company WHERE partner_id = $1", [partner])).rows.length) {
      throw new NotPorted("a UBL bank account of one of the database's companies (the log 'The bank account couldn't be fetched')");
    }
    // `with_context(clean_context(...))`: no default_* keys
    const ctx = Object.fromEntries(Object.entries(env.context).filter(([k]) => !k.startsWith("default_")));
    const [id] = await ormCreate(env.withContext(ctx), "res.partner.bank", [{ account_number: number, partner_id: partner, allow_out_payment: false }]);
    rows = (await env.cr.query<{ id: number; partner_id: number; active: boolean | null; company_id: number | null; trusted: boolean | null }>(
      "SELECT id, partner_id, active, company_id, allow_out_payment AS trusted FROM res_partner_bank WHERE id = $1", [id])).rows;
  }
  const ancestors = await companyAncestors(env, company);
  const usable = rows.filter((r) => r.active && (r.company_id === null || ancestors.includes(r.company_id)));
  usable.sort((a, b) => Number(a.partner_id !== partner) - Number(b.partner_id !== partner));
  const best = usable[0];
  return best ? { id: best.id, trusted: Boolean(best.trusted) } : null;
}

/** account_move.py:5039 `_link_bill_origin_to_purchase_orders(timeout=4)` -> purchase account_invoice.py:577-660 with no references. */
async function linkPurchaseOrders(env: Environment, moveId: number, company: number, partner: number): Promise<boolean> {
  const m = (await env.cr.query<{ t: string; origin: string | null }>("SELECT amount_total::text AS t, invoice_origin AS origin FROM account_move WHERE id = $1", [moveId])).rows[0]!;
  const total = Number(m.t);
  // account_move.py:6511-6515: the references of the origin
  const refs = (m.origin ?? "").match(/[^,\s]+/gu) ?? [];
  const common = "o.company_id = $1 AND o.state = 'purchase' AND o.invoice_status IN ('to invoice', 'no')";
  if (refs.length && total) {
    // :529-541 the orders named, else those whose vendor reference is one of them: a match fills the bill from them
    const byName = (await env.cr.query(`SELECT o.id FROM purchase_order o WHERE ${common} AND o.name = ANY($2::text[])`, [company, refs])).rows;
    const byRef = byName.length ? [] : (await env.cr.query(`SELECT o.id FROM purchase_order o WHERE ${common} AND o.partner_ref = ANY($2::text[])`, [company, refs])).rows;
    if (byName.length || byRef.length) throw new NotPorted("a purchase order matching the imported bill's references (_set_purchase_orders, the EDI line matching)");
  }
  if (!total) return finishNoMatch(env, moveId, m.origin);
  // :532-546 the last resort: one open purchase order of the vendor (child_of) within 0.02 of the total
  // `child_of` without a parent store (res.partner has no parent_path): the partner and its children, recursively
  const found = (await env.cr.query(
    `WITH RECURSIVE tree(id) AS (SELECT $2::int UNION SELECT p.id FROM res_partner p JOIN tree ON p.parent_id = tree.id)
     SELECT o.id FROM purchase_order o
      WHERE o.company_id = $1 AND o.state = 'purchase' AND o.invoice_status IN ('to invoice', 'no')
        AND o.partner_id IN (SELECT id FROM tree) AND o.amount_total >= $3 AND o.amount_total <= $4`, [company, partner, total - 0.02, total + 0.02])).rows;
  if (found.length === 1) throw new NotPorted("a purchase order matching the imported bill (total_match: the bill takes its lines)");
  return finishNoMatch(env, moveId, m.origin);
}

/** :661-662 no purchase order on the lines: `invoice_origin = False`, a tracked write after the decoder's commit. */
async function finishNoMatch(env: Environment, moveId: number, origin: string | null): Promise<boolean> {
  if (!origin) return false; // already empty: an unchanged value is not written
  await ormWrite(env, "account.move", [moveId], { invoice_origin: false });
  return true;
}

/** account_edi_ubl_cii account_move.py:185-208: the lines grouped by tax like the vendor's last posted bill. */
async function groupLinesPostProcess(env: Environment, moveId: number, company: number, partner: number): Promise<void> {
  const m = (await env.cr.query<{ state: string; lines: number; grouped: boolean | null }>(
    `SELECT state, has_grouped_lines AS grouped, (SELECT count(*)::int FROM account_move_line WHERE move_id = m.id
       AND display_type IN ('product', 'line_section', 'line_subsection', 'line_note')) AS lines FROM account_move m WHERE id = $1`, [moveId])).rows[0]!;
  // :177-183 `_check_move_for_group_ungroup_lines_by_tax`: a draft with two lines or grouped lines
  if (m.state !== "draft" || (m.lines <= 1 && !m.grouped)) return;
  const ancestors = await companyAncestors(env, company);
  const last = (await env.cr.query<{ g: boolean | null }>(
    `SELECT has_grouped_lines AS g FROM account_move WHERE move_type IN ('in_invoice', 'in_refund', 'in_receipt') AND partner_id = $1 AND state = 'posted'
        AND id != $2 AND (company_id IS NULL OR company_id = ANY($3::int[])) ORDER BY create_date DESC, id DESC LIMIT 1`, [partner, moveId, ancestors])).rows[0];
  if (last?.g) throw new NotPorted("the lines grouped by tax like the vendor's last bill (_group_lines_by_tax)");
}

/**
 * `message_post(body=Markup, attachment_ids=[...])` as the import calls it (account_edi_common.py:2022): a note
 * (notification, mt_note) by the user, the attachment already on the bill (`_process_attachments_for_post` leaves it),
 * then `_notify_thread`. account.move's `_message_post_after_hook` leaves a notification alone (account_move.py:8012) and
 * the main attachment skips XML files (mail_thread_main_attachment.py:35-40).
 */
async function postImportMessage(env: Environment, moveId: number, body: string, attachmentIds: number[]): Promise<void> {
  const ctx = requestOfCursor(env.cr);
  if (ctx === null) throw new NotPorted("a UBL import outside a request");
  const [authorId, emailFrom] = await computeAuthor(env, null, null);
  const company = await recordCompany(env, "account.move", moveId);
  const parentId = await flatThreadParent(env, "account.move", moveId);
  const [id] = await insertMessages(env, [{
    model: "account.move", res_id: moveId, body: sanitizeBody(body), author_id: authorId, email_from: emailFrom, message_type: "notification",
    subtype_id: await xmlid(env, "mail.mt_note"), subject: false, email_add_signature: true, record_alias_domain_id: false,
    record_company_id: company, reply_to: emailFrom, message_id: trackingMessageId(`${moveId}-account.move`), attachment_ids: attachmentIds,
    partner_ids: [], ...(parentId ? { parent_id: parentId } : {}),
  }]);
  // mail_thread_main_attachment.py:17-47 after the post (account_move.py:8012 leaves a notification to it): as
  // superuser, when the bill has no main attachment, a PDF first, then an image, XML files left out
  const main = (await env.cr.query<{ m: number | null }>("SELECT message_main_attachment_id AS m FROM account_move WHERE id = $1", [moveId])).rows[0]?.m ?? null;
  if (main === null) {
    const rows = (await env.cr.query<{ id: number; mimetype: string | null }>("SELECT id, mimetype FROM ir_attachment WHERE id = ANY($1::int[])", [attachmentIds])).rows
      .filter((a) => !(a.mimetype ?? "").endsWith("xml") && !(a.mimetype ?? "").endsWith("application/octet-stream") && a.mimetype !== "message/rfc822");
    if (rows.length) {
      const rank = (a: { mimetype: string | null }): number => ((a.mimetype ?? "").endsWith("pdf") ? 2 : 0) + ((a.mimetype ?? "").startsWith("image") ? 1 : 0);
      const best = Math.max(...rows.map(rank));
      const top = rows.filter((a) => rank(a) === best);
      if (top.length > 1) throw new NotPorted("the main attachment among several embedded documents of the same kind");
      await ormWrite(env.sudo(), "account.move", [moveId], { message_main_attachment_id: top[0]!.id });
    }
  }
  const notified = await notifyThread(ctx, env, "account.move", moveId, id!);
  await notified.send();
}

/**
 * account_edi_ubl.py:3006-3031 the substitute PDF with a PDF engine (the deployed Worker, D8b: Browser Run renders the
 * report's html, so other bytes than wkhtmltopdf's): the report account_edi_ubl_cii.account_invoices_generated_by_odoo
 * of the bill, as the send wizard renders (src/models/account_move_send.ts); the layout record exists, so no banner is
 * added (:3017-3024); the attachment "<the bill's name without Draft> - Generated by Odoo.pdf" on the bill, made its
 * main attachment (`_message_set_main_attachment_id(force=True, filter_xml=False)`). Not proven against the oracle,
 * which has no engine (D8b: the PDF engine is an adapter outside the measure; in measurements the port runs without
 * a PDF engine, as the oracle, so the html is compared: proofs/scenarios/pdf_html_ubl.py).
 */
async function substitutePdf(env: Environment, moveId: number): Promise<number> {
  if (!(await env.cr.query("SELECT 1 FROM ir_model_data WHERE module = 'account_edi_ubl_cii' AND name = 'layout_invoices_generated_by_odoo'")).rows.length) {
    throw new NotPorted("the substitute PDF's banner (pdf.add_banner without the layout record)");
  }
  const { renderReportPdfInRequest } = await import("../controllers/report");
  const data = await renderReportPdfInRequest(env, "account_edi_ubl_cii.account_invoices_generated_by_odoo", [moveId]);
  const display = (await env.model("account.move").displayName([moveId])).get(moveId) ?? "";
  // `invoice.display_name.replace(_('Draft'), '')`: every occurrence (Python str.replace)
  const name = display.split(translate(env, "Draft", "account_edi_ubl_cii")).join("");
  const filename = translate(env, "%(invoice_name)s - Generated by Odoo", "account_edi_ubl_cii").replace("%(invoice_name)s", name);
  const id = await createBinaryAttachment(env, {
    name: `${filename}.pdf`, description: null, data, mimetype: "application/pdf", resModel: "account.move", resId: moveId, resField: null, company: await env.company(),
  });
  await ormWrite(env, "account.move", [moveId], { message_main_attachment_id: id });
  return id;
}

/** account_edi_common.py:136-143 SUPPORTED_FILE_TYPES */
const SUPPORTED_FILE_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": ".pdf", "application/vnd.oasis.opendocument.spreadsheet": ".ods",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx", "image/jpeg": ".jpeg", "image/png": ".png", "text/csv": ".csv",
};

/**
 * account_edi_common.py:651-688 `_import_attachments`: each AdditionalDocumentReference with an ID and an embedded
 * binary object of a supported type becomes an attachment of the bill: the base64 text without whitespace, padded as
 * Odoo pads it, decoded strictly (fields_binary.py:85-93 `b64decode(validate=True)`); the name the ID's last path part
 * before its first dot, with the type's extension. PDFs only here (images go through `_postprocess_contents`, the
 * spreadsheets' and CSV's indexing is not checked).
 */
async function importEmbeddedDocuments(env: Environment, moveId: number, tree: Element, main: number | null): Promise<number[]> {
  const out: number[] = [];
  for (const doc of findall(tree, "./{*}AdditionalDocumentReference")) {
    const idNode = find(doc, "{*}ID");
    const dataNode = find(doc, "{*}Attachment/{*}EmbeddedDocumentBinaryObject");
    if (idNode === null || dataNode === null) continue;
    const mimetype = dataNode.attrib.get("mimeCode");
    const ext = mimetype ? SUPPORTED_FILE_TYPES[mimetype] : undefined;
    if (!ext) continue;
    if (mimetype !== "application/pdf") throw new NotPorted(`an embedded ${mimetype} document in a UBL file`);
    const text = (dataNode.text ?? "").split(/\s+/u).join("");
    const padded = text + "=".repeat(text.length % 4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded) || padded.length % 4 !== 0) throw new NotPorted("an embedded document whose base64 Odoo rejects (the import's error)");
    const data = new Uint8Array(Buffer.from(padded, "base64"));
    const base = (idNode.text || "invoice").split("\\").pop()!.split("/").pop()!.split(".")[0]!;
    if (main !== null) throw new NotPorted("an embedded document on a bill with a main attachment (:681-686)");
    out.push(await createBinaryAttachment(env, {
      name: base + ext, description: null, data, mimetype, resModel: "account.move", resId: moveId, resField: null, company: await env.company(),
    }));
  }
  return out;
}

/** account_edi_ubl.py:2605-2686 `_import_ubl_invoice_line_add_vehicle_values`: whether one VIN or plate per field is found. */
function vehicleValues(tree: Element, line: Element): boolean {
  const byName = (identifier: string) => (parent: Element) => findtext(parent, "./{*}Name") === identifier;
  const paths: { move: boolean; parent: string; value: string; field: string; cond: (p: Element, n: Element) => boolean; pattern?: RegExp }[] = [
    { move: false, parent: "./{*}Item/{*}AdditionalItemProperty", value: "./{*}Value", field: "vin_sn", cond: byName("SerialNumber") },
    { move: false, parent: "./{*}Item/{*}AdditionalItemProperty", value: "./{*}Value", field: "vin_sn", cond: byName("VIN") },
    { move: false, parent: "./{*}Item/{*}AdditionalItemProperty", value: "./{*}Value", field: "license_plate", cond: byName("PlateNumber") },
    { move: false, parent: "./{*}Item/{*}AdditionalItemProperty", value: "./{*}Value", field: "license_plate", cond: byName("LCPL-NO") },
    { move: false, parent: "./{*}Item", value: "./{*}Description", field: "vin_sn", cond: () => true, pattern: /[A-Z0-9]{17}/g },
    { move: false, parent: "./{*}Item", value: "./{*}Description", field: "license_plate", cond: () => true, pattern: /[\p{Nd}MQOTZ]-?[A-Z]{3}-?\p{Nd}{3}/gu },
    { move: true, parent: "./{*}AdditionalDocumentReference", value: "./{*}ID", field: "vin_sn", cond: (_p, n) => n.attrib.get("schemeID") === "AKG" },
    { move: true, parent: "./{*}AdditionalDocumentReference", value: "./{*}ID", field: "license_plate", cond: (_p, n) => n.attrib.get("schemeID") === "ABZ" },
  ];
  const results = new Map<string, Set<string>>();
  for (const p of paths) {
    for (const parent of findall(p.move ? tree : line, p.parent)) {
      const node = find(parent, p.value);
      if (node === null || !p.cond(parent, node)) continue;
      const value = node.text;
      if (value === null) continue;
      const set = results.get(p.field) ?? new Set<string>();
      if (p.pattern) {
        const found = value.match(p.pattern) ?? [];
        if (found.length) { results.set(p.field, set); for (const f of found) set.add(f); }
      } else {
        results.set(p.field, set);
        set.add(value);
      }
    }
  }
  return results.size > 0 && [...results.values()].every((s) => s.size === 1);
}

/** account uom_uom.py:3-32 UOM_TO_UNECE_CODE, inverted. */
const UNECE_TO_UOM: Readonly<Record<string, string>> = Object.fromEntries(Object.entries({
  "uom.product_uom_unit": "C62", "uom.product_uom_dozen": "DZN", "uom.product_uom_kgm": "KGM", "uom.product_uom_gram": "GRM",
  "uom.product_uom_day": "DAY", "uom.product_uom_hour": "HUR", "uom.product_uom_minute": "MIN", "uom.product_uom_ton": "TNE",
  "uom.product_uom_meter": "MTR", "uom.product_uom_km": "KMT", "uom.product_uom_cm": "CMT", "uom.product_uom_litre": "LTR",
  "uom.product_uom_lb": "LBR", "uom.product_uom_oz": "ONZ", "uom.product_uom_inch": "INH", "uom.product_uom_foot": "FOT",
  "uom.product_uom_mile": "SMI", "uom.product_uom_floz": "OZA", "uom.product_uom_qt": "QTL", "uom.product_uom_gal": "GLL",
  "uom.product_uom_cubic_meter": "MTQ", "uom.product_uom_cubic_inch": "INQ", "uom.product_uom_cubic_foot": "FTQ",
  "uom.uom_square_meter": "MTK", "uom.uom_square_foot": "FTK", "uom.product_uom_yard": "YRD", "uom.product_uom_millimeter": "MMT",
  "uom.product_uom_kwh": "KWH",
}).map(([k, v]) => [v, k]));

export { bis3Tree };
