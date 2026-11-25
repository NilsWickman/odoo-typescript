/**
 * Wave 2 Accounting wizards & remaining UI object-button methods, matching Odoo 20 Community source in
 * `odoo/addons/{account,sale,purchase}`:
 * - `account.move.action_purchase_matching` (purchase/models/account_invoice.py:224-244)
 * - `account.move.action_move_download_all` (account/models/account_move.py:6780-6797)
 * - `account.fiscal.position.action_create_foreign_taxes` (account/models/partner.py:310-321, chart_template.py:980-1122)
 * - `bill.to.po.wizard.action_add_downpayment` (purchase/wizard/bill_to_po_wizard.py:43-77)
 * - `account.automatic.entry.wizard` (account/wizard/account_automatic_entry_wizard.py)
 * - `account.accrued.orders.wizard` (account/wizard/accrued_orders.py, sale/wizard/accrued_orders.py, purchase/wizard/accrued_orders.py)
 */
import { AccessError, NotPorted, OdooError, UserError, ValidationError } from "../errors";
import { registerMethod } from "../http/methods";
import { escapeText, messageLogBatch } from "../mail/message";
import { floatRound } from "../orm/convert";
import { create } from "../orm/create";
import { and, cond, or } from "../orm/domain";
import { DbRec, RecomputeQueue, registerDefaults, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Environment } from "../orm/types";
import { unlink } from "../orm/unlink";
import { registerOverrides, write } from "../orm/write";
import { envFor } from "../web/common";
import { userHasGroup } from "../web/groups";
import { fetchRecords, isAdmin, postMoves, xmlidId } from "./account_buttons";
import { contextToday } from "./account_computes";
import { finalizeTracking, insertRow, linesById, mailAfterCreate, moveRow, reconcileLines, reconcilePair, type Row, type TrackingDefer } from "./account_entries";
import { accountingDateAfterLocks, DATE_MIN, formatDate, formatLockDates, userLockDate, violatedLockDates } from "./account_locks";
import { productAccountOf } from "./account_move_create";
import { buttonDraft, productValuation } from "./account_move_ops";
import { chartFile, companyRow, derefTaxTags, loadData, Loader, templateDataFor, type Data, type Key, type Vals } from "./chart_template";
import { convertAmount } from "./currency_convert";
import { deduceReset, lastSequence } from "./invoicing_computes";
import { formatLangCurrency } from "./product_computes";
import { postNote } from "./stock_engine";
import { defineComputes, withCompany } from "./tail_util";
import { translate } from "./util";
import { dumps } from "../http/json";

const PURCHASE_R = ["in_invoice", "in_refund", "in_receipt"];

type MethodFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function btn(model: string, method: string, fn: MethodFn): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: false });
}

function ensureOne(ids: readonly number[], model: string): number {
  if (ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: ${model}(${ids.join(", ")}${ids.length ? "," : ""})`);
  }
  return ids[0]!;
}

function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" && v > 0 ? v : null;
}

function numVal(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "object" && v !== null && "float" in v) return Number((v as { float: number }).float);
  return Number(v ?? 0);
}

function addDays(isoDate: string, delta: number): string {
  const dt = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
}

function ellipsis(s: string, size: number): string {
  return s.length > size ? `${s.slice(0, size - 3)}...` : s;
}

const pyFloat = (n: number): { float: number } => ({ float: n });

/** Python `json.dumps(v)` with default separators (", ", ": ") and ensure_ascii=True, keeping PyFloat `.0`. */
function pyJsonDumps(v: unknown): string {
  return dumps(v, { ensureAscii: true });
}

async function currencyInfo(env: Environment, currencyId: number): Promise<{ rounding: number; places: number }> {
  const r = (await env.cr.query<{ rounding: number; places: number }>(
    "SELECT rounding::float8 AS rounding, decimal_places AS places FROM res_currency WHERE id = $1", [currencyId])).rows[0];
  return r ?? { rounding: 0.01, places: 2 };
}

function curRound(v: number, places: number): number {
  return floatRound(v, places);
}

function curIsZero(v: number, rounding: number): boolean {
  const places = Math.max(0, Math.round(-Math.log10(rounding || 0.01)));
  return Math.abs(floatRound(v, places)) === 0;
}

/** account_move.py:7525-7537 `_move_dict_to_preview_vals(move_vals, currency_id=None)`. */
async function moveDictToPreviewVals(
  env: Environment,
  moveVals: Record<string, unknown>,
  currencyId: number | null,
): Promise<Record<string, unknown>> {
  const dateStr = moveVals["date"] ? await formatDate(env, String(moveVals["date"])) : translate(env, "[Not set]", "account");
  const refStr = moveVals["ref"] === null || moveVals["ref"] === undefined ? "None" : String(moveVals["ref"]);
  const rawLines = (moveVals["line_ids"] as unknown[][] | undefined) ?? [];
  const itemsVals: unknown[] = [];
  for (const cmd of rawLines) {
    const lineDict = { ...((cmd[2] as Record<string, unknown>) ?? {}) };
    if ("partner_id" in lineDict) {
      const pid = m2oId(lineDict["partner_id"]);
      if (pid) {
        const names = await env.sudo().model("res.partner").displayName([pid]);
        lineDict["partner_id"] = names.get(pid) ?? false;
      } else {
        lineDict["partner_id"] = false;
      }
    }
    const aid = m2oId(lineDict["account_id"]);
    if (aid) {
      const names = await env.model("account.account").displayName([aid]);
      lineDict["account_id"] = names.get(aid) || translate(env, "Destination Account", "account");
    } else {
      lineDict["account_id"] = translate(env, "Destination Account", "account");
    }
    const debitNum = numVal(lineDict["debit"]);
    const creditNum = numVal(lineDict["credit"]);
    lineDict["debit"] = currencyId ? await formatLangCurrency(env, debitNum, currencyId) : debitNum;
    lineDict["credit"] = currencyId ? await formatLangCurrency(env, creditNum, currencyId) : creditNum;
    if ("amount_currency" in lineDict && typeof lineDict["amount_currency"] === "number") {
      lineDict["amount_currency"] = pyFloat(lineDict["amount_currency"]);
    }
    itemsVals.push([cmd[0], cmd[1], lineDict]);
  }
  return {
    group_name: `${dateStr}, ${refStr}`,
    items_vals: itemsVals,
  };
}

/** `record._get_html_link(title=...)` (mail_thread.py). */
async function moveHtmlLink(env: Environment, moveId: number, title?: string): Promise<string> {
  const label = title ?? ((await env.model("account.move").displayName([moveId])).get(moveId) ?? "");
  return `<a href="#" data-oe-model="account.move" data-oe-id="${moveId}">${escapeText(label)}</a>`;
}

// =================================================================================================
// 1. account.move.action_purchase_matching (purchase/models/account_invoice.py:224-244)
// =================================================================================================

btn("account.move", "action_purchase_matching", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], ["partner_id", "commercial_partner_id", "company_id"]);
  const partnerId = m2oId(move!["partner_id"]);
  const commPartnerId = m2oId(move!["commercial_partner_id"]);
  const companyId = m2oId(move!["company_id"]);
  const partnerIds: number[] = [];
  if (partnerId) partnerIds.push(partnerId);
  if (commPartnerId && !partnerIds.includes(commPartnerId)) partnerIds.push(commPartnerId);
  const companies = await env.companies();
  const viewId = await xmlidId(env, "purchase.purchase_bill_line_match_tree");
  return {
    type: "ir.actions.act_window",
    name: translate(env, "Purchase Matching", "purchase"),
    res_model: "purchase.bill.line.match",
    context: {
      partner_id: partnerId ?? false,
    },
    domain: [
      ["partner_id", "in", partnerIds],
      ["company_id", "in", companies],
      ["company_id", "child_of", companyId ? [companyId] : []],
      "|", "|", "|",
      ["account_move_id", "in", [id]],
      ["pol_id.invoice_lines.move_id", "in", [id]],
      ["qty_to_invoice_raw", "!=", 0],
      ["qty_to_invoice", "!=", 0],
    ],
    views: [[viewId, "list"]],
  };
});

// =================================================================================================
// 2. account.move.action_move_download_all (account/models/account_move.py:6780-6797, :8240-8261)
// =================================================================================================

btn("account.move", "action_move_download_all", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids, ["move_type", "state", "message_main_attachment_id"]);
  const attRows = ids.length ? (await env.sudo().cr.query<{ res_id: number; res_field: string }>(
    `SELECT res_id, res_field FROM ir_attachment
      WHERE res_model = 'account.move' AND res_id = ANY($1::int[])
        AND res_field IN ('invoice_pdf_report_file', 'ubl_cii_xml_file')`,
    [ids],
  )).rows : [];
  const pdfSet = new Set<number>();
  const ublSet = new Set<number>();
  for (const r of attRows) {
    if (r.res_field === "invoice_pdf_report_file") pdfSet.add(r.res_id);
    if (r.res_field === "ubl_cii_xml_file") ublSet.add(r.res_id);
  }
  const movesToExport: number[] = [];
  for (const m of moves) {
    const mid = Number(m["id"]);
    const mtype = String(m["move_type"]);
    const main = m2oId(m["message_main_attachment_id"]);
    let hasDocs = false;
    if (PURCHASE_R.includes(mtype)) {
      hasDocs = Boolean(main || pdfSet.has(mid) || ublSet.has(mid));
    } else if (m["state"] === "draft" && main) {
      hasDocs = true;
    } else {
      // _get_invoice_legal_documents_all: requires invoice_pdf_report_id
      hasDocs = pdfSet.has(mid);
    }
    if (hasDocs) movesToExport.push(mid);
  }
  if (!movesToExport.length) {
    return {
      type: "ir.actions.client",
      tag: "display_notification",
      params: {
        message: translate(env, "No files found to download", "account"),
        type: "warning",
        sticky: false,
      },
    };
  }
  return {
    type: "ir.actions.act_url",
    url: `/account/download_move_attachments/${movesToExport.join(",")}`,
    target: "download",
  };
});

// =================================================================================================
// 3. account.fiscal.position.action_create_foreign_taxes (partner.py:310-321, chart_template.py:980-1122)
// =================================================================================================

/** account_account.py:504-585 `_search_new_account_code(start_code)`. */
async function searchNewAccountCode(env: Environment, companyId: number, startCode: string): Promise<string> {
  if (!startCode) return startCode;
  const cenv = await withCompany(env, companyId);
  const su = cenv.sudo().withContext({ ...cenv.context, active_test: false });
  const cache = new Set<string>([startCode]);
  const isAvailable = async (code: string): Promise<boolean> => {
    if (cache.has(code)) return false;
    const count = await su.model("account.account").searchCount(
      and([
        cond("code", "=", code),
        or([cond("company_ids", "parent_of", [companyId]), cond("company_ids", "child_of", [companyId])]),
      ]),
    );
    return count === 0;
  };
  const m = /^(.*?)(\d*)(\D*)$/.exec(startCode);
  const startStr = m?.[1] ?? "";
  const digitsStr = m?.[2] ?? "";
  const endStr = m?.[3] ?? "";
  if (digitsStr !== "") {
    const d = digitsStr.length;
    const n = parseInt(digitsStr, 10);
    const limit = Math.pow(10, d);
    for (let num = n + 1; num < limit; num++) {
      const candidate = `${startStr}${String(num).padStart(d, "0")}${endStr}`;
      if (await isAvailable(candidate)) return candidate;
    }
  }
  for (let num = 0; num < 99; num++) {
    const candidate = `${startCode}.copy${num ? num + 1 : ""}`;
    if (await isAvailable(candidate)) return candidate;
  }
  throw new UserError(translate(env, "Cannot generate an unused account code.", "account"));
}

/** chart_template.py:980-988 `_create_foreign_account`. */
async function createForeignAccount(
  env: Environment,
  companyId: number,
  existingAccountId: number,
  additionalLabel: string,
  reconcilable = false,
): Promise<number> {
  const cenv = await withCompany(env, companyId);
  const [acc] = await cenv.sudo().model("account.account").read(
    [existingAccountId],
    ["name", "code", "account_type", "reconcile", "non_trade"],
    "",
  );
  if (!acc) throw new NotPorted(`_create_foreign_account: missing account ${existingAccountId}`);
  const newCode = await searchNewAccountCode(env, companyId, String(acc["code"] ?? ""));
  const [createdId] = await create(cenv, "account.account", [{
    name: `${String(acc["name"])} - ${additionalLabel}`,
    code: newCode,
    account_type: acc["account_type"],
    reconcile: reconcilable || Boolean(acc["reconcile"]),
    non_trade: Boolean(acc["non_trade"]),
    company_ids: [[4, companyId, 0]],
  }]);
  return createdId!;
}

/** Known chart template codes backed by generated `gen/out/poc_erp/chart/<code>.json`. */
const CHART_CODES_BY_COUNTRY_CODE: Record<string, string> = {
  US: "us",
  SE: "se",
};

btn("account.fiscal.position", "action_create_foreign_taxes", async (env, ids) => {
  if (!(await isAdmin(env)) && !(await userHasGroup(env, "account.group_account_manager"))) {
    throw new AccessError(translate(env, "Only Accounting managers can create foreign taxes.", "account"));
  }
  const id = ensureOne(ids, "account.fiscal.position");
  const [fpos] = await fetchRecords(env, "account.fiscal.position", [id], ["country_id", "company_id"]);
  const countryId = m2oId(fpos!["country_id"]);
  const companyId = m2oId(fpos!["company_id"]) ?? await env.company();
  if (!countryId) throw new UserError(translate(env, "Please select a country on the fiscal position.", "account"));
  const countryRow = (await env.cr.query<{ code: string }>("SELECT code FROM res_country WHERE id = $1", [countryId])).rows[0];
  const countryCode = countryRow?.code ?? "";
  const templateCode = CHART_CODES_BY_COUNTRY_CODE[countryCode];
  if (!templateCode) {
    throw new NotPorted(`action_create_foreign_taxes for country ${countryCode} (no generated chart template file)`);
  }
  const file = await chartFile(env, templateCode);
  const mapping = file.mapping[templateCode];
  if (!mapping) throw new NotPorted(`action_create_foreign_taxes: chart template ${templateCode} missing in mapping`);
  const modRow = (await env.cr.query<{ state: string }>("SELECT state FROM ir_module_module WHERE name = $1", [mapping.module])).rows[0];
  if (!modRow || modRow.state !== "installed") {
    throw new NotPorted(`action_create_foreign_taxes: localization module ${mapping.module} is not installed`);
  }

  // chart_template.py:1005-1010: check if taxes already exist for this country in this company
  const existingTaxes = await env.model("account.tax").search(
    and([cond("company_id", "parent_of", [companyId]), cond("country_id", "=", countryId)]),
  );
  if (existingTaxes.length) {
    // Matches Odoo: _instantiate_foreign_taxes returns None -> partner.py:320 AttributeError
    throw new OdooError("builtins.AttributeError", "'NoneType' object has no attribute 'get'");
  }

  const cenv = await withCompany(env, companyId);
  const c = await companyRow(cenv.sudo(), companyId);
  const rootId = Number(c["root_id"]);
  const fiscalCountryId = (c["account_fiscal_country_id"] as number | null) ?? (c["country_id"] as number | null);
  const defaultSaleTax = c["account_sale_tax_id"] as number | null;
  const defaultPurchaseTax = c["account_purchase_tax_id"] as number | null;
  const defaultCompanyTaxIds = [defaultSaleTax, defaultPurchaseTax].filter((x): x is number => typeof x === "number" && x > 0);

  const { data } = await templateDataFor(cenv.sudo(), file, companyId);
  const ld = new Loader(cenv.sudo().withContext({ ...cenv.context, default_company_id: companyId, allowed_company_ids: [companyId], lang: "en_US" }), companyId, rootId);
  await derefTaxTags(ld, file, data);

  const taxGroupData = data.get("account.tax.group") ?? new Map<Key, Vals>();
  const taxData = data.get("account.tax") ?? new Map<Key, Vals>();

  const existingAccounts: Record<string, number | null> = { "": null };

  // chart_template.py:1019-1051: create repartition line foreign accounts
  for (const taxTemplate of taxData.values()) {
    const repLines = (taxTemplate["repartition_line_ids"] as unknown[][] | undefined) ?? [];
    for (const cmd of repLines) {
      const repLine = cmd[2] as Record<string, unknown> | undefined;
      if (!repLine || !("account_id" in repLine) || repLine["repartition_type"] !== "tax") continue;
      const acctXmlId = String(repLine["account_id"] ?? "");
      if (acctXmlId in existingAccounts) continue;
      const typeTaxUse = String(taxTemplate["type_tax_use"] ?? "sale");
      const factor = Number(repLine["factor_percent"] ?? 100);
      const signCmp = factor < 0 ? "<" : ">";

      const minimal = [
        cond("company_id", "parent_of", [companyId]),
        cond("account_id", "!=", false),
        cond("factor_percent", signCmp, 0),
      ];
      const additional = [
        cond("tax_id.type_tax_use", "=", typeTaxUse),
        ...(fiscalCountryId ? [cond("tax_id.country_id", "=", fiscalCountryId)] : []),
        cond("tax_id", "in", defaultCompanyTaxIds),
      ];
      let similarId: number | null = null;
      while (similarId === null && additional.length) {
        const found = await cenv.model("account.tax.repartition.line").search(and([...minimal, ...additional]), { limit: 1 });
        if (found.length) similarId = found[0]!;
        additional.pop();
      }
      if (similarId !== null) {
        const [repRow] = await cenv.sudo().model("account.tax.repartition.line").read([similarId], ["account_id"], "");
        const localTaxAccId = m2oId(repRow?.["account_id"]);
        if (localTaxAccId) {
          const label = translate(cenv, "Foreign tax account (%s)", "account").replace("%s", countryCode);
          existingAccounts[acctXmlId] = await createForeignAccount(cenv, companyId, localTaxAccId, label);
        }
      }
    }
  }

  // chart_template.py:1053-1082: cash basis transition accounts
  const localCabaTaxIds = fiscalCountryId ? await cenv.model("account.tax").search(
    and([
      cond("company_id", "parent_of", [companyId]),
      cond("country_id", "=", fiscalCountryId),
      cond("tax_exigibility", "=", "on_payment"),
      cond("cash_basis_transition_account_id", "!=", false),
    ]),
    { limit: 1 },
  ) : [];
  let localCabaAccId: number | null = null;
  if (localCabaTaxIds.length) {
    const [r] = await cenv.sudo().model("account.tax").read([localCabaTaxIds[0]!], ["cash_basis_transition_account_id"], "");
    localCabaAccId = m2oId(r?.["cash_basis_transition_account_id"]);
  }
  let hasCashBasis = false;
  const sortedTaxes = [...taxData.values()].sort((a, b) => {
    const aHas = ((a["repartition_line_ids"] as unknown[][] | undefined) ?? []).some((c) => Boolean((c[2] as Record<string, unknown> | undefined)?.["account_id"])) ? 1 : 0;
    const bHas = ((b["repartition_line_ids"] as unknown[][] | undefined) ?? []).some((c) => Boolean((c[2] as Record<string, unknown> | undefined)?.["account_id"])) ? 1 : 0;
    return bHas - aHas;
  });
  for (const taxTemplate of sortedTaxes) {
    if (taxTemplate["tax_exigibility"] === "on_payment") {
      hasCashBasis = true;
      const accXmlId = String(taxTemplate["cash_basis_transition_account_id"] ?? "");
      if (!(accXmlId in existingAccounts)) {
        if (localCabaAccId) {
          existingAccounts[accXmlId] = await createForeignAccount(
            cenv, companyId, localCabaAccId, translate(cenv, "Cash basis transition account", "account"), true,
          );
        } else {
          const repAccXmlIds = ((taxTemplate["repartition_line_ids"] as unknown[][] | undefined) ?? [])
            .map((c) => (c[2] as Record<string, unknown> | undefined)?.["account_id"])
            .filter((x): x is string => typeof x === "string" && Boolean(x));
          const firstAcc = repAccXmlIds.length ? existingAccounts[repAccXmlIds[0]!] : null;
          if (firstAcc) {
            existingAccounts[accXmlId] = await createForeignAccount(
              cenv, companyId, firstAcc, translate(cenv, "Cash basis transition account", "account"), true,
            );
          } else {
            existingAccounts[accXmlId] = null;
          }
        }
      }
    }
  }
  if (hasCashBasis) {
    await write(cenv.sudo(), "res.company", [companyId], { tax_exigibility: true });
  }

  // chart_template.py:1084-1122: transform templates, prefix xmlids, loadData
  const prefixedGroups = new Map<Key, Vals>();
  for (const [xmlid, vals] of taxGroupData) {
    prefixedGroups.set(`${templateCode}_${String(xmlid)}`, vals);
  }
  const prefixedTaxes = new Map<Key, Vals>();
  const prefixedTaxXmlIds: string[] = [];
  for (const [xmlid, taxTemplate] of taxData) {
    taxTemplate["country_id"] = countryId;
    if (taxTemplate["tax_group_id"]) {
      taxTemplate["tax_group_id"] = `${templateCode}_${String(taxTemplate["tax_group_id"])}`;
    }
    for (const cmd of (taxTemplate["repartition_line_ids"] as unknown[][] | undefined) ?? []) {
      const repLine = cmd[2] as Record<string, unknown> | undefined;
      if (!repLine) continue;
      const origAcc = repLine["account_id"];
      repLine["account_id"] = typeof origAcc === "string" ? (existingAccounts[origAcc] ?? false) : (origAcc ?? false);
    }
    delete taxTemplate["fiscal_position_ids"];
    delete taxTemplate["original_tax_ids"];
    const cabaXmlId = taxTemplate["cash_basis_transition_account_id"];
    if (typeof cabaXmlId === "string" && cabaXmlId) {
      taxTemplate["cash_basis_transition_account_id"] = existingAccounts[cabaXmlId] ?? false;
    }
    if (taxTemplate["amount_type"] === "group" && typeof taxTemplate["children_tax_ids"] === "string" && taxTemplate["children_tax_ids"]) {
      taxTemplate["children_tax_ids"] = taxTemplate["children_tax_ids"].split(",").map((c) => `${templateCode}_${c}`).join(",");
    }
    const px = `${templateCode}_${String(xmlid)}`;
    prefixedTaxes.set(px, taxTemplate);
    prefixedTaxXmlIds.push(px);
  }

  const loadPayload: Data = new Map<string, Map<Key, Vals>>([
    ["account.tax.group", prefixedGroups],
    ["account.tax", prefixedTaxes],
  ]);
  await loadData(ld, loadPayload);

  // Link created taxes to this fiscal position (`created_records['account.tax'].fiscal_position_ids += self`)
  const createdTaxIds: number[] = [];
  for (const px of prefixedTaxXmlIds) {
    const tid = await ld.ref(px, false);
    if (tid !== null) createdTaxIds.push(tid);
  }
  if (createdTaxIds.length) {
    for (const tid of createdTaxIds) {
      await env.cr.query(
        "INSERT INTO account_fiscal_position_account_tax_rel (account_fiscal_position_id, account_tax_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [id, tid],
      );
    }
    // Recompute tax_map on fiscal position and is_domestic on created taxes
    const q = new RecomputeQueue(env);
    await q.modified("account.fiscal.position", [id], ["tax_ids"]);
    await q.modified("account.tax", createdTaxIds, ["fiscal_position_ids"]);
    await q.run();
  }
  return null;
});

// =================================================================================================
// 4. bill.to.po.wizard.action_add_downpayment (purchase/wizard/bill_to_po_wizard.py:43-77)
// =================================================================================================

btn("bill.to.po.wizard", "action_add_downpayment", async (env, ids) => {
  const wizId = ensureOne(ids, "bill.to.po.wizard");
  const [wiz] = await fetchRecords(env, "bill.to.po.wizard", [wizId], ["purchase_order_id", "partner_id"]);
  const activeIds = (env.context["active_ids"] as number[] | undefined) ?? [];
  const amlIds = activeIds.filter((x) => x < 0).map((x) => Math.abs(x));
  const amlRows = amlIds.length ? await fetchRecords(env, "account.move.line", amlIds, [
    "move_id", "partner_id", "display_name", "product_uom_id", "price_unit", "currency_id", "tax_ids",
  ]) : [];

  const partnerSet = new Set<number>();
  for (const r of amlRows) {
    const pid = m2oId(r["partner_id"]);
    if (pid) partnerSet.add(pid);
  }
  if (partnerSet.size > 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: res.partner(${[...partnerSet].join(", ")})`);
  }
  const linePartnerId = [...partnerSet][0] ?? false;

  let poId = m2oId(wiz!["purchase_order_id"]);
  if (!poId) {
    const [createdPo] = await create(env, "purchase.order", [{ partner_id: linePartnerId }]);
    poId = createdPo!;
    await write(env, "bill.to.po.wizard", [wizId], { purchase_order_id: poId });
  }

  const [po] = await fetchRecords(env, "purchase.order", [poId], ["currency_id", "company_id", "date_order"]);
  const poCurrencyId = m2oId(po!["currency_id"])!;
  const poCompanyId = m2oId(po!["company_id"]) ?? await env.company();
  const poDateOrder = String(po!["date_order"] ?? "").slice(0, 10) || await contextToday(env);

  // _create_downpayments: ensure section line exists
  let sectionSeq: number;
  const existingSection = (await env.cr.query<{ id: number; sequence: number }>(
    `SELECT id, sequence FROM purchase_order_line
      WHERE order_id = $1 AND display_type IS NOT NULL AND is_downpayment = TRUE
      ORDER BY sequence, id LIMIT 1`,
    [poId],
  )).rows[0];
  if (existingSection) {
    sectionSeq = existingSection.sequence;
  } else {
    const lastLine = (await env.cr.query<{ sequence: number | null }>(
      "SELECT sequence FROM purchase_order_line WHERE order_id = $1 ORDER BY sequence DESC, id DESC LIMIT 1",
      [poId],
    )).rows[0];
    sectionSeq = (lastLine?.sequence || 9) + 1;
    await create(env, "purchase.order.line", [{
      product_qty: 0.0,
      order_id: poId,
      display_type: "line_section",
      is_downpayment: true,
      sequence: sectionSeq,
      name: translate(env, "Down Payments", "purchase"),
    }]);
  }

  const dpVals: Record<string, unknown>[] = [];
  for (let i = 0; i < amlRows.length; i++) {
    const aml = amlRows[i]!;
    const amlCur = m2oId(aml["currency_id"]) ?? poCurrencyId;
    const rawPrice = numVal(aml["price_unit"]);
    const priceUnit = amlCur !== poCurrencyId
      ? await convertAmount(env, rawPrice, amlCur, poCurrencyId, poCompanyId, poDateOrder)
      : rawPrice;
    const taxIds = (aml["tax_ids"] as number[] | undefined) ?? [];
    dpVals.push({
      name: translate(env, "Down Payment (ref: %(ref)s)", "purchase").replace("%(ref)s", String(aml["display_name"] ?? "")),
      product_qty: 0.0,
      uom_id: m2oId(aml["product_uom_id"]) ?? false,
      is_downpayment: true,
      price_unit: priceUnit,
      tax_ids: [[6, 0, taxIds]],
      order_id: poId,
      sequence: sectionSeq + i + 1,
    });
  }

  const dpLineIds = dpVals.length ? await create(env, "purchase.order.line", dpVals) : [];
  const linkedMoveIds = new Set<number>();
  for (let i = 0; i < amlRows.length && i < dpLineIds.length; i++) {
    const amlId = Number(amlRows[i]!["id"]);
    const mvId = m2oId(amlRows[i]!["move_id"]);
    const dplId = dpLineIds[i]!;
    await env.cr.query(
      "UPDATE account_move_line SET purchase_line_id = $2, write_uid = $3, write_date = (now() AT TIME ZONE 'UTC') WHERE id = $1",
      [amlId, dplId, env.uid],
    );
    if (mvId) linkedMoveIds.add(mvId);
  }
  if (linkedMoveIds.size) {
    const { touchSyncedInvoices } = await import("./account_entries");
    await touchSyncedInvoices(env, [...linkedMoveIds]);
  }
  if (dpLineIds.length) {
    const q = new RecomputeQueue(env.sudo());
    await q.modified("purchase.order.line", dpLineIds, ["invoice_lines"]);
    await q.run();
  }

  return {
    type: "ir.actions.act_window",
    res_model: "purchase.order",
    view_mode: "form",
    res_id: poId,
  };
});

// =================================================================================================
// 5. account.automatic.entry.wizard (account/wizard/account_automatic_entry_wizard.py)
// =================================================================================================

interface AutoLineRow {
  id: number;
  move_id: number;
  move_name: string | null;
  move_date: string;
  date: string;
  account_id: number;
  account_type: string;
  partner_id: number | null;
  currency_id: number;
  company_id: number;
  company_currency_id: number;
  debit: number;
  credit: number;
  balance: number;
  amount_currency: number;
  analytic_distribution: Record<string, number> | null;
}

async function autoWizardLineIds(rec: Rec): Promise<number[]> {
  const rels = await rec.rels("move_line_ids");
  return rels.map((r) => r.origin).filter((id): id is number => id !== null);
}

async function loadAutoLines(env: Environment, lineIds: readonly number[]): Promise<AutoLineRow[]> {
  if (!lineIds.length) return [];
  return (await env.cr.query<AutoLineRow>(
    `SELECT l.id, l.move_id, m.name AS move_name, m.date::text AS move_date, l.date::text AS date,
            l.account_id, a.account_type, l.partner_id, l.currency_id, l.company_id, l.company_currency_id,
            COALESCE(l.debit, 0)::float8 AS debit, COALESCE(l.credit, 0)::float8 AS credit,
            COALESCE(l.balance, 0)::float8 AS balance, COALESCE(l.amount_currency, 0)::float8 AS amount_currency,
            l.analytic_distribution
       FROM account_move_line l
       JOIN account_move m ON m.id = l.move_id
       JOIN account_account a ON a.id = l.account_id
      WHERE l.id = ANY($1::int[])
      ORDER BY array_position($1::int[], l.id)`,
    [[...lineIds]],
  )).rows;
}

/** account_move.py:7458-7495 + account_automatic_entry_wizard.py:317-320 `_get_lock_safe_date(date)`. */
async function lockSafeDate(env: Environment, companyId: number, journalId: number, date: string): Promise<string> {
  const jtype = (await env.cr.query<{ t: string | null }>("SELECT type AS t FROM account_journal WHERE id = $1", [journalId])).rows[0]?.t ?? null;
  const locks = await violatedLockDates(env, companyId, date, false, jtype);
  const today = await contextToday(env);
  const lastRow = (await env.cr.query<{ name: string | null }>(
    `SELECT name FROM account_move
      WHERE journal_id = $1 AND state = 'posted' AND name IS NOT NULL AND name != '/'
      ORDER BY sequence_prefix DESC, sequence_number DESC LIMIT 1`,
    [journalId],
  )).rows[0];
  const highest = lastRow?.name ?? null;
  return accountingDateAfterLocks(false, date, today, highest, highest ? deduceReset(highest) : "never", locks);
}

/** account_automatic_entry_wizard.py:542-555 `_format_strings`. */
async function autoFormatStrings(
  env: Environment,
  template: string,
  opts: {
    percentage: number;
    wizDate: string | null;
    companyCurrencyId: number;
    destAccountName: string;
    moveId: number;
    moveName: string | null;
    moveDate: string;
    amount?: number | null;
    accountSourceName?: string;
  },
): Promise<string> {
  const label = opts.moveName || translate(env, "Adjusting Entry", "account");
  const percent = Number(opts.percentage).toFixed(2);
  const amountStr = opts.amount ? await formatLangCurrency(env, Math.abs(opts.amount), opts.companyCurrencyId) : "";
  const debitCredit = opts.amount ? (opts.amount < 0 ? translate(env, "C", "account") : translate(env, "D", "account")) : "None";
  const link = await moveHtmlLink(env, opts.moveId);
  const dateStr = await formatDate(env, opts.moveDate);
  const newDateStr = opts.wizDate ? await formatDate(env, opts.wizDate) : translate(env, "[Not set]", "account");
  const vars: Record<string, string> = {
    label,
    percent,
    name: opts.moveName ?? "False",
    id: String(opts.moveId),
    amount: amountStr,
    debit_credit: debitCredit,
    link,
    date: dateStr,
    new_date: newDateStr,
    account_source_name: opts.accountSourceName ?? "",
    account_target_name: opts.destAccountName,
  };
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

function canonicalAnalyticKey(ad: Record<string, number> | null | undefined): string {
  if (!ad || !Object.keys(ad).length) return "";
  return JSON.stringify(Object.keys(ad).sort().map((k) => [k, ad[k]]));
}

/** account_automatic_entry_wizard.py:322-359 `_get_move_dict_vals_change_period`. */
async function buildChangePeriodMoveVals(env: Environment, rec: Rec): Promise<Record<string, unknown>[]> {
  const lineIds = await autoWizardLineIds(rec);
  const lines = await loadAutoLines(env, lineIds);
  if (!lines.length) return [];
  const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
  const journalId = m2oId(await rec.get("journal_id"));
  const wizDate = String((await rec.get("date")) ?? "");
  const percentage = Number((await rec.get("percentage")) ?? 100);
  const accountType = String((await rec.get("account_type")) ?? "expense");
  const accrualAccountId = m2oId(await rec.get(accountType === "income" ? "revenue_accrual_account" : "expense_accrual_account"));
  const destAccId = m2oId(await rec.get("destination_account_id"));
  const destAccName = destAccId ? ((await env.model("account.account").displayName([destAccId])).get(destAccId) ?? "") : "";

  const jRow = journalId ? (await env.cr.query<{ cur: number | null; ccur: number }>(
    "SELECT j.currency_id AS cur, c.currency_id AS ccur FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = $1",
    [journalId],
  )).rows[0] : undefined;
  const moveCurrencyId = jRow?.cur ?? jRow?.ccur ?? (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  const companyCurrencyId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  const originMoveIds = [...new Set(lines.map((l) => l.move_id))];

  const refFormat = percentage === 100
    ? translate(env, "Cut-off {label}", "account")
    : translate(env, "Cut-off {label} {percent}%", "account");

  const first = lines[0]!;
  const moveData = new Map<string, Record<string, unknown>>();
  moveData.set("new_date", {
    currency_id: moveCurrencyId,
    move_type: "entry",
    line_ids: [] as unknown[],
    ref: await autoFormatStrings(env, refFormat, {
      percentage, wizDate, companyCurrencyId, destAccountName: destAccName,
      moveId: first.move_id, moveName: first.move_name, moveDate: first.move_date,
    }),
    date: wizDate,
    journal_id: journalId ?? false,
    adjusting_entry_origin_move_ids: originMoveIds,
  });

  // Group lines by lock-safe date (preserving first-seen order like itertools/odoo.tools.groupby)
  const lineSafeDates = new Map<number, string>();
  const bySafeDate = new Map<string, AutoLineRow[]>();
  for (const aml of lines) {
    const safe = journalId ? await lockSafeDate(env, companyId, journalId, aml.date) : aml.date;
    lineSafeDates.set(aml.id, safe);
    const grp = bySafeDate.get(safe);
    if (grp) grp.push(aml); else bySafeDate.set(safe, [aml]);
  }
  for (const [safeDate, grp] of bySafeDate) {
    const amount = grp.reduce((s, l) => s + l.balance, 0);
    moveData.set(safeDate, {
      currency_id: moveCurrencyId,
      move_type: "entry",
      line_ids: [] as unknown[],
      ref: await autoFormatStrings(env, refFormat, {
        percentage, wizDate, companyCurrencyId, destAccountName: destAccName,
        moveId: grp[0]!.move_id, moveName: grp[0]!.move_name, moveDate: grp[0]!.move_date, amount,
      }),
      date: safeDate,
      journal_id: journalId ?? false,
      adjusting_entry_origin_move_ids: originMoveIds,
    });
  }

  for (const aml of lines) {
    const ccInfo = await currencyInfo(env, aml.company_currency_id);
    const fcInfo = await currencyInfo(env, aml.currency_id);
    const reportedDebit = curRound((percentage / 100) * aml.debit, ccInfo.places);
    const reportedCredit = curRound((percentage / 100) * aml.credit, ccInfo.places);
    const reportedAmountCurrency = curRound((percentage / 100) * aml.amount_currency, fcInfo.places);
    const name = await autoFormatStrings(env, refFormat, {
      percentage, wizDate, companyCurrencyId, destAccountName: destAccName,
      moveId: aml.move_id, moveName: aml.move_name, moveDate: aml.move_date,
    });
    const safe = lineSafeDates.get(aml.id)!;
    const ad = aml.analytic_distribution ?? false;

    const newDateLines = moveData.get("new_date")!["line_ids"] as unknown[];
    newDateLines.push(
      [0, 0, {
        name, debit: pyFloat(reportedDebit), credit: pyFloat(reportedCredit), amount_currency: pyFloat(reportedAmountCurrency),
        currency_id: aml.currency_id, account_id: aml.account_id, partner_id: aml.partner_id ?? false,
        analytic_distribution: ad,
      }],
      [0, 0, {
        name, debit: pyFloat(reportedCredit), credit: pyFloat(reportedDebit), amount_currency: pyFloat(-reportedAmountCurrency),
        currency_id: aml.currency_id, account_id: accrualAccountId ?? false, partner_id: aml.partner_id ?? false,
        analytic_distribution: ad,
      }],
    );

    const safeLines = moveData.get(safe)!["line_ids"] as unknown[];
    safeLines.push(
      [0, 0, {
        name, debit: pyFloat(reportedCredit), credit: pyFloat(reportedDebit), amount_currency: pyFloat(-reportedAmountCurrency),
        currency_id: aml.currency_id, account_id: aml.account_id, partner_id: aml.partner_id ?? false,
        analytic_distribution: ad,
      }],
      [0, 0, {
        name, debit: pyFloat(reportedDebit), credit: pyFloat(reportedCredit), amount_currency: pyFloat(reportedAmountCurrency),
        currency_id: aml.currency_id, account_id: accrualAccountId ?? false, partner_id: aml.partner_id ?? false,
        analytic_distribution: ad,
      }],
    );
  }

  return [...moveData.values()];
}

/** account_automatic_entry_wizard.py:170-261 `_get_move_dict_vals_change_account`. */
async function buildChangeAccountMoveVals(env: Environment, rec: Rec): Promise<Record<string, unknown>[]> {
  const lineIds = await autoWizardLineIds(rec);
  const lines = await loadAutoLines(env, lineIds);
  const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
  const journalId = m2oId(await rec.get("journal_id"));
  const wizDate = String((await rec.get("date")) ?? "");
  const destAccId = m2oId(await rec.get("destination_account_id"));
  const destAccRow = destAccId ? (await env.cr.query<{ cur: number | null }>("SELECT currency_id AS cur FROM account_account WHERE id = $1", [destAccId])).rows[0] : undefined;
  const destAccCur = destAccRow?.cur ?? null;
  const destAccName = destAccId ? ((await env.model("account.account").displayName([destAccId])).get(destAccId) ?? "") : "";

  const companyCurId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  const ccInfo = await currencyInfo(env, companyCurId);

  const counterpartBalances = new Map<string, {
    partnerId: number | null;
    currencyId: number;
    amountCurrency: number;
    balance: number;
    distAmount: Record<string, number>;
  }>();
  const groupedSource = new Map<string, {
    partnerId: number | null;
    currencyId: number;
    accountId: number;
    analytic: Record<string, number> | null;
    lines: AutoLineRow[];
  }>();

  for (const line of lines) {
    if (destAccId !== null && line.account_id === destAccId) continue;
    let cpCur = line.currency_id;
    let cpAmtCur = line.amount_currency;
    if (destAccCur && destAccCur !== companyCurId) {
      cpCur = destAccCur;
      cpAmtCur = await convertAmount(env, line.balance, companyCurId, destAccCur, companyId, line.date);
    }
    const gKey = `${line.partner_id ?? ""}/${cpCur}`;
    let cp = counterpartBalances.get(gKey);
    if (!cp) {
      cp = { partnerId: line.partner_id, currencyId: cpCur, amountCurrency: 0, balance: 0, distAmount: {} };
      counterpartBalances.set(gKey, cp);
    }
    cp.amountCurrency += cpAmtCur;
    cp.balance += line.balance;
    if (line.analytic_distribution) {
      for (const [accKey, dist] of Object.entries(line.analytic_distribution)) {
        cp.distAmount[accKey] = (line.balance * dist + (cp.distAmount[accKey] ?? 0) * 100) / 100;
      }
    }
    const sKey = `${line.partner_id ?? ""}/${line.currency_id}/${line.account_id}/${canonicalAnalyticKey(line.analytic_distribution)}`;
    let sg = groupedSource.get(sKey);
    if (!sg) {
      sg = { partnerId: line.partner_id, currencyId: line.currency_id, accountId: line.account_id, analytic: line.analytic_distribution, lines: [] };
      groupedSource.set(sKey, sg);
    }
    sg.lines.push(line);
  }

  const lineVals: Record<string, unknown>[] = [];
  const sourceAccIds = [...new Set(lines.map((l) => l.account_id))];
  const singleSourceName = sourceAccIds.length === 1 ? ((await env.model("account.account").displayName(sourceAccIds)).get(sourceAccIds[0]!) ?? "") : "";
  const cpLabel = sourceAccIds.length === 1
    ? translate(env, "Transfer from %s", "account").replace("%s", singleSourceName)
    : translate(env, "Transfer counterpart", "account");

  for (const cp of counterpartBalances.values()) {
    const cpCurInfo = await currencyInfo(env, cp.currencyId);
    const ad: Record<string, number> = {};
    for (const [accKey, distAmt] of Object.entries(cp.distAmount)) {
      ad[accKey] = curIsZero(cp.balance, cpCurInfo.rounding) ? 100 : (100 * distAmt) / cp.balance;
    }
    if (!curIsZero(cp.amountCurrency, cpCurInfo.rounding) || !curIsZero(cp.balance, ccInfo.rounding)) {
      const signedAc = curRound((cp.balance < 0 ? -1 : 1) * Math.abs(cp.amountCurrency), cpCurInfo.places);
      lineVals.push({
        name: cpLabel,
        debit: cp.balance > 0 ? pyFloat(curRound(cp.balance, ccInfo.places)) : 0,
        credit: cp.balance < 0 ? pyFloat(curRound(-cp.balance, ccInfo.places)) : 0,
        account_id: destAccId ?? false,
        partner_id: cp.partnerId ?? null,
        amount_currency: signedAc ? pyFloat(signedAc) : 0,
        currency_id: cp.currencyId,
        analytic_distribution: ad,
      });
    }
  }

  const toLabel = translate(env, "Transfer to %s", "account").replace("%s", destAccName || translate(env, "[Not set]", "account"));
  for (const sg of groupedSource.values()) {
    const accBalance = sg.lines.reduce((s, l) => s + l.balance, 0);
    if (!curIsZero(accBalance, ccInfo.rounding)) {
      const sgCurInfo = await currencyInfo(env, sg.currencyId);
      const accAmtCur = curRound(sg.lines.reduce((s, l) => s + l.amount_currency, 0), sgCurInfo.places);
      lineVals.push({
        name: toLabel,
        debit: accBalance < 0 ? pyFloat(curRound(-accBalance, ccInfo.places)) : 0,
        credit: accBalance > 0 ? pyFloat(curRound(accBalance, ccInfo.places)) : 0,
        account_id: sg.accountId,
        partner_id: sg.partnerId ?? null,
        currency_id: sg.currencyId,
        amount_currency: pyFloat((accBalance > 0 ? -1 : 1) * Math.abs(accAmtCur)),
        analytic_distribution: sg.analytic ? { ...sg.analytic } : false,
      });
    }
  }

  // Lowest child company based on accounts used
  const envCo = await env.company();
  const usedAccIds = [...new Set(lineVals.map((l) => m2oId(l["account_id"])).filter((x): x is number => x !== null))];
  let lowestCompany = envCo;
  if (usedAccIds.length) {
    const coRows = (await env.cr.query<{ id: number; parent_path: string }>(
      `SELECT DISTINCT c.id, c.parent_path FROM account_account_res_company_rel r
         JOIN res_company c ON c.id = r.res_company_id
        WHERE r.account_account_id = ANY($1::int[])
          AND ('/' || c.parent_path) LIKE ('%/' || $2::text || '/%')`,
      [usedAccIds, envCo],
    )).rows;
    let maxDepth = (await env.cr.query<{ p: string }>("SELECT parent_path AS p FROM res_company WHERE id = $1", [envCo])).rows[0]?.p.split("/").filter(Boolean).length ?? 1;
    for (const c of coRows) {
      const depth = c.parent_path.split("/").filter(Boolean).length;
      if (depth > maxDepth) { maxDepth = depth; lowestCompany = c.id; }
    }
  }

  const jRow = journalId ? (await env.cr.query<{ cur: number | null; ccur: number }>(
    "SELECT j.currency_id AS cur, c.currency_id AS ccur FROM account_journal j JOIN res_company c ON c.id = j.company_id WHERE j.id = $1",
    [journalId],
  )).rows[0] : undefined;
  const moveCurrencyId = jRow?.cur ?? jRow?.ccur ?? companyCurId;

  return [{
    currency_id: moveCurrencyId,
    move_type: "entry",
    name: "/",
    journal_id: journalId ?? false,
    company_id: lowestCompany,
    date: wizDate,
    ref: destAccName ? translate(env, "Transfer entry to %s", "account").replace("%s", destAccName) : false,
    line_ids: lineVals.map((lv) => [0, 0, lv]),
  }];
}

registerDefaults("account.automatic.entry.wizard", {
  date: async (env) => contextToday(env),
});

registerOverrides("account.automatic.entry.wizard", {
  defaultGet: async (env, fields, values) => {
    if (!fields.includes("move_line_ids") && !fields.includes("company_id")) return;
    const activeIds = env.context["active_model"] === "account.move.line" ? (env.context["active_ids"] as number[] | undefined) ?? [] : [];
    if (!activeIds.length) {
      throw new UserError(translate(env, "This can only be used on journal items", "account"));
    }
    values["move_line_ids"] = [[6, 0, activeIds]];
    const rows = (await env.cr.query<{ id: number; state: string; reconciled: boolean; root_id: number; account_type: string }>(
      `SELECT l.id, m.state, COALESCE(l.reconciled, FALSE) AS reconciled,
              split_part(c.parent_path, '/', 1)::int AS root_id, a.account_type
         FROM account_move_line l
         JOIN account_move m ON m.id = l.move_id
         JOIN res_company c ON c.id = l.company_id
         JOIN account_account a ON a.id = l.account_id
        WHERE l.id = ANY($1::int[])
        ORDER BY array_position($1::int[], l.id)`,
      [activeIds],
    )).rows;
    if (rows.some((r) => r.state !== "posted")) {
      throw new UserError(translate(env, "Oops! You can only change the period or account for posted entries! Other ones aren't up for an adventure like that!", "account"));
    }
    if (rows.some((r) => r.reconciled)) {
      throw new UserError(translate(env, "Oops! You can only change the period or account for items that are not yet reconciled! Other ones aren't up for an adventure like that!", "account"));
    }
    const root0 = rows[0]!.root_id;
    if (rows.some((r) => r.root_id !== root0)) {
      throw new UserError(translate(env, "You cannot use this wizard on journal entries belonging to different companies.", "account"));
    }
    values["company_id"] = root0;
    const allowed = new Set<string>(env.context["default_action"] ? [String(env.context["default_action"])] : ["change_period", "change_account"]);
    const type0 = rows[0]!.account_type;
    if (rows.some((r) => r.account_type !== type0)) {
      allowed.delete("change_period");
    }
    if (!allowed.size) {
      throw new UserError(translate(env, "No possible action found with the selected lines.", "account"));
    }
    values["action"] = [...allowed][0]!;
  },
  create: async (env, valsList, next) => {
    const invs = valsList.map((v) => {
      const out: Record<string, unknown> = {};
      for (const f of ["journal_id", "expense_accrual_account", "revenue_accrual_account"]) {
        if (f in v) { out[f] = v[f]; delete v[f]; }
      }
      return out;
    });
    const ids = await next(env, valsList);
    for (let i = 0; i < ids.length; i++) {
      const inv = invs[i]!;
      if (!Object.keys(inv).length) continue;
      const cid = (await env.cr.query<{ c: number | null }>("SELECT company_id AS c FROM account_automatic_entry_wizard WHERE id = $1", [ids[i]])).rows[0]?.c;
      if (!cid) continue;
      const coVals: Record<string, unknown> = {};
      if ("journal_id" in inv) coVals["automatic_entry_default_journal_id"] = inv["journal_id"] || false;
      if ("expense_accrual_account" in inv) coVals["expense_accrual_account_id"] = inv["expense_accrual_account"] || false;
      if ("revenue_accrual_account" in inv) coVals["revenue_accrual_account_id"] = inv["revenue_accrual_account"] || false;
      if (Object.keys(coVals).length) await write(env.sudo(), "res.company", [cid], coVals);
    }
    return ids;
  },
  write: async (env, ids, vals0, next) => {
    const vals = { ...vals0 };
    const coVals: Record<string, unknown> = {};
    if ("journal_id" in vals) { coVals["automatic_entry_default_journal_id"] = vals["journal_id"] || false; delete vals["journal_id"]; }
    if ("expense_accrual_account" in vals) { coVals["expense_accrual_account_id"] = vals["expense_accrual_account"] || false; delete vals["expense_accrual_account"]; }
    if ("revenue_accrual_account" in vals) { coVals["revenue_accrual_account_id"] = vals["revenue_accrual_account"] || false; delete vals["revenue_accrual_account"]; }
    if (Object.keys(vals).length) await next(env, ids, vals);
    if (Object.keys(coVals).length && ids.length) {
      const cids = [...new Set((await env.cr.query<{ c: number }>("SELECT company_id AS c FROM account_automatic_entry_wizard WHERE id = ANY($1::int[]) AND company_id IS NOT NULL", [ids])).rows.map((r) => r.c))];
      if (cids.length) await write(env.sudo(), "res.company", cids, coVals);
    }
  },
  constraints: [
    {
      fields: ["percentage", "action"],
      fn: async (env, ids) => {
        const rows = (await env.cr.query<{ action: string; percentage: number }>(
          "SELECT action, COALESCE(percentage, 0)::float8 AS percentage FROM account_automatic_entry_wizard WHERE id = ANY($1::int[])", [ids])).rows;
        for (const r of rows) {
          if (r.action === "change_period" && !(r.percentage > 0.0 && r.percentage <= 100.0)) {
            throw new UserError(translate(env, "Percentage must be between 0 and 100", "account"));
          }
        }
      },
    },
    {
      fields: ["date", "move_line_ids"],
      fn: async (env, ids) => {
        for (const id of ids) {
          const [w] = (await env.cr.query<{ date: string | null }>(
            "SELECT date::text AS date FROM account_automatic_entry_wizard WHERE id = $1", [id])).rows;
          if (!w?.date) continue;
          const moves = (await env.cr.query<{ company_id: number; jtype: string | null }>(
            `SELECT DISTINCT m.company_id, j.type AS jtype
               FROM account_automatic_entry_wizard_account_move_line_rel r
               JOIN account_move_line l ON l.id = r.account_move_line_id
               JOIN account_move m ON m.id = l.move_id
               JOIN account_journal j ON j.id = m.journal_id
              WHERE r.account_automatic_entry_wizard_id = $1`, [id])).rows;
          for (const mv of moves) {
            const locks = await violatedLockDates(env, mv.company_id, w.date, false, mv.jtype);
            if (locks.length) {
              throw new ValidationError(
                translate(env, "The date selected is protected by: %(lock_date_info)s.", "account")
                  .replace("%(lock_date_info)s", await formatLockDates(env, locks)),
              );
            }
          }
        }
      },
    },
  ],
});

registerRecordCompute("account.automatic.entry.wizard", {
  account_type: async (env, rec) => {
    const lineIds = await autoWizardLineIds(rec);
    if (!lineIds.length) return "expense";
    const sum = Number((await env.cr.query<{ s: string }>("SELECT COALESCE(SUM(balance), 0)::text AS s FROM account_move_line WHERE id = ANY($1::int[])", [lineIds])).rows[0]!.s);
    return sum < 0 ? "income" : "expense";
  },
  total_amount: async (env, rec) => {
    const lineIds = await autoWizardLineIds(rec);
    const pct = Number((await rec.prev("percentage")) ?? 0) || 100;
    const sum = lineIds.length ? Number((await env.cr.query<{ s: string }>("SELECT COALESCE(SUM(balance), 0)::text AS s FROM account_move_line WHERE id = ANY($1::int[])", [lineIds])).rows[0]!.s) : 0;
    return (pct * sum) / 100;
  },
  percentage: async (env, rec) => {
    const lineIds = await autoWizardLineIds(rec);
    const prevTotal = Number((await rec.prev("total_amount")) ?? 0);
    const sum = lineIds.length ? Number((await env.cr.query<{ s: string }>("SELECT COALESCE(SUM(balance), 0)::text AS s FROM account_move_line WHERE id = ANY($1::int[])", [lineIds])).rows[0]!.s) : 0;
    const total = sum || prevTotal;
    if (total !== 0 && prevTotal !== 0) return Math.min((prevTotal / total) * 100, 100);
    return 100;
  },
});

defineComputes("account.automatic.entry.wizard", {
  expense_accrual_account: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id"));
    if (!companyId) return false;
    const row = (await env.cr.query<{ v: number | null }>("SELECT expense_accrual_account_id AS v FROM res_company WHERE id = $1", [companyId])).rows[0];
    return row?.v ?? false;
  },
  revenue_accrual_account: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id"));
    if (!companyId) return false;
    const row = (await env.cr.query<{ v: number | null }>("SELECT revenue_accrual_account_id AS v FROM res_company WHERE id = $1", [companyId])).rows[0];
    return row?.v ?? false;
  },
  journal_id: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id"));
    if (!companyId) return false;
    const row = (await env.cr.query<{ v: number | null }>("SELECT automatic_entry_default_journal_id AS v FROM res_company WHERE id = $1", [companyId])).rows[0];
    return row?.v ?? false;
  },
  lock_date_message: async (env, rec) => {
    if ((await rec.get("action")) !== "change_period") return false;
    const lineIds = await autoWizardLineIds(rec);
    if (!lineIds.length) return false;
    const rows = (await env.cr.query<{ date: string; company_id: number; jtype: string | null; journal_id: number }>(
      `SELECT l.date::text AS date, m.company_id, j.type AS jtype, m.journal_id
         FROM account_move_line l JOIN account_move m ON m.id = l.move_id JOIN account_journal j ON j.id = m.journal_id
        WHERE l.id = ANY($1::int[]) ORDER BY array_position($1::int[], l.id)`,
      [lineIds],
    )).rows;
    for (const r of rows) {
      const locks = await violatedLockDates(env, r.company_id, r.date, false, r.jtype);
      if (locks.length) {
        const acctDate = await lockSafeDate(env, r.company_id, r.journal_id, r.date);
        return translate(env, "The date is being set prior to: %(lock_date_info)s. The Journal Entry will be accounted on %(invoice_date)s upon posting.", "account")
          .replace("%(lock_date_info)s", await formatLockDates(env, locks))
          .replace("%(invoice_date)s", await formatDate(env, acctDate));
      }
    }
    return false;
  },
  display_currency_helper: async (env, rec) => {
    const destId = m2oId(await rec.get("destination_account_id"));
    if (!destId) return false;
    const cur = (await env.cr.query<{ c: number | null }>("SELECT currency_id AS c FROM account_account WHERE id = $1", [destId])).rows[0]?.c;
    return Boolean(cur);
  },
  move_data: async (env, rec) => {
    const action = String((await rec.get("action")) ?? "");
    if (action === "change_period") {
      const lineIds = await autoWizardLineIds(rec);
      const lines = await loadAutoLines(env, lineIds);
      if (lines.length && lines.some((l) => l.account_type !== lines[0]!.account_type)) {
        throw new UserError(translate(env, "All accounts on the lines must be of the same type.", "account"));
      }
      return pyJsonDumps(await buildChangePeriodMoveVals(env, rec));
    }
    if (action === "change_account") {
      return pyJsonDumps(await buildChangeAccountMoveVals(env, rec));
    }
    return false;
  },
  preview_move_data: async (env, rec) => {
    const action = String((await rec.get("action")) ?? "");
    const raw = (await rec.get("move_data")) as string | false | null;
    if (!raw) return false;
    const moveVals = JSON.parse(raw) as Record<string, unknown>[];
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const curId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
    const columns: Record<string, unknown>[] = [
      { field: "account_id", label: translate(env, "Account", "account") },
      { field: "name", label: translate(env, "Label", "account") },
      ...(action === "change_account" ? [{ field: "partner_id", label: translate(env, "Partner", "account") }] : []),
      { field: "debit", label: translate(env, "Debit", "account"), class: "text-end text-nowrap" },
      { field: "credit", label: translate(env, "Credit", "account"), class: "text-end text-nowrap" },
    ];
    const previewVals: Record<string, unknown>[] = [];
    for (const mv of moveVals.slice(0, 4)) {
      previewVals.push(await moveDictToPreviewVals(env, mv, curId));
    }
    const discarded = Math.max(0, moveVals.length - previewVals.length);
    return pyJsonDumps({
      groups_vals: previewVals,
      options: {
        discarded_number: discarded ? translate(env, "%d moves", "account").replace("%d", String(discarded)) : false,
        columns,
      },
    });
  },
});

btn("account.automatic.entry.wizard", "do_action", async (env, ids) => {
  const wizId = ensureOne(ids, "account.automatic.entry.wizard");
  const rec = new DbRec(env, env.reg.model("account.automatic.entry.wizard"), wizId);
  const action = String((await rec.get("action")) ?? "");
  const rawMoveData = String((await rec.get("move_data")) ?? "[]");
  const moveVals = JSON.parse(rawMoveData) as Record<string, unknown>[];
  const wizEnv = env.withContext({ ...env.context, skip_computed_taxes: true });

  const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
  const companyCurrencyId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  const journalId = m2oId(await rec.get("journal_id"))!;
  const wizDate = String((await rec.get("date")) ?? "");
  const percentage = Number((await rec.get("percentage")) ?? 100);
  const lineIds = await autoWizardLineIds(rec);
  const srcLines = await loadAutoLines(wizEnv, lineIds);

  if (action === "change_period") {
    const accountType = String((await rec.get("account_type")) ?? "expense");
    const accrualAccountId = m2oId(await rec.get(accountType === "income" ? "revenue_accrual_account" : "expense_accrual_account"));
    const destAccId = m2oId(await rec.get("destination_account_id"));
    const destAccName = destAccId ? ((await wizEnv.model("account.account").displayName([destAccId])).get(destAccId) ?? "") : "";

    // Convert adjusting_entry_origin_move_ids array into M2M command [[6, 0, ids]] for create()
    const createVals = moveVals.map((mv) => {
      const copy = { ...mv };
      if (Array.isArray(copy["adjusting_entry_origin_move_ids"])) {
        copy["adjusting_entry_origin_move_ids"] = [[6, 0, copy["adjusting_entry_origin_move_ids"]]];
      }
      return copy;
    });
    const createdMoves = await create(wizEnv, "account.move", createVals);
    await postMoves(wizEnv, createdMoves, true);

    // Reconcile mirror lines across createdMoves
    const createdLines = (await wizEnv.cr.query<{
      id: number; name: string | null; account_id: number; partner_id: number | null;
      currency_id: number; balance: number; reconcile: boolean | null;
      analytic_distribution: Record<string, number> | null; rounding: number;
    }>(
      `SELECT l.id, l.name, l.account_id, l.partner_id, l.currency_id,
              COALESCE(l.balance, 0)::float8 AS balance, a.reconcile, l.analytic_distribution, c.rounding::float8 AS rounding
         FROM account_move_line l
         JOIN account_account a ON a.id = l.account_id
         JOIN res_currency c ON c.id = l.currency_id
        WHERE l.move_id = ANY($1::int[])
        ORDER BY array_position($1::int[], l.move_id), l.id`,
      [createdMoves],
    )).rows;

    const groups = new Map<string, number[]>();
    for (const l of createdLines) {
      if ((l.account_id === accrualAccountId || l.reconcile) && !curIsZero(l.balance, l.rounding)) {
        const key = `${l.name ?? ""}\0${l.account_id}\0${l.partner_id ?? ""}\0${l.currency_id}\0${canonicalAnalyticKey(l.analytic_distribution)}`;
        const g = groups.get(key);
        if (g) g.push(l.id); else groups.set(key, [l.id]);
      }
    }
    const recEnv = wizEnv.withContext({ ...wizEnv.context, no_exchange_difference: true, no_cash_basis: true });
    const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
    for (const grpIds of groups.values()) {
      if (grpIds.length < 2) continue;
      const lRows = await linesById(recEnv, grpIds);
      const hasD = lRows.some((x) => x.amount_residual > 0 || x.amount_residual_currency > 0);
      const hasC = lRows.some((x) => x.amount_residual < 0 || x.amount_residual_currency < 0);
      if (!hasD || !hasC) continue;
      if (lRows.length === 2) await reconcilePair(recEnv, lRows[0]!, lRows[1]!, defer);
      else await reconcileLines(recEnv, lRows, defer);
    }

    // Chatter messages
    const destinationMoveId = createdMoves[0]!;
    const accrualMoves = createdMoves.slice(1);
    const accrualMoveDates = new Map<number, string>();
    for (const amId of accrualMoves) {
      accrualMoveDates.set(amId, (await moveRow(wizEnv, amId)).date);
    }

    const srcMoveIds = [...new Set(srcLines.map((l) => l.move_id))];
    const destMessages: string[] = [];
    const accrualMoveMessages = new Map<number, string[]>();

    for (const mvId of srcMoveIds) {
      const mvLines = srcLines.filter((l) => l.move_id === mvId);
      const amount = mvLines.reduce((s, l) => s + l.balance, 0);
      const mvRow = mvLines[0]!;
      const safe = await lockSafeDate(wizEnv, companyId, journalId, mvRow.move_date);
      const accMoveId = accrualMoves.find((amId) => accrualMoveDates.get(amId) === safe) ?? accrualMoves[0]!;
      const fmtOpts = {
        percentage, wizDate, companyCurrencyId, destAccountName: destAccName,
        moveId: mvId, moveName: mvRow.move_name, moveDate: mvRow.move_date, amount,
      };
      const title = escapeText(translate(wizEnv, "Adjusting Entries have been created for this invoice:", "account"));
      const link1 = await moveHtmlLink(wizEnv, accMoveId);
      // Odoo's msgids keep `%%` and str.format leaves it: the chatter reads "50.00%% of" (measured, sweep2_account)
      const second = await autoFormatStrings(wizEnv, translate(wizEnv, "cancelling {percent}%% of {amount}", "account"), fmtOpts);
      const link2 = await moveHtmlLink(wizEnv, destinationMoveId);
      const third = await autoFormatStrings(wizEnv, translate(wizEnv, "postponing it to {new_date}", "account"), fmtOpts);
      const body = `<p>${title}</p><ul><li>${link1} ${escapeText(second)}</li><li>${link2} ${escapeText(third)}</li></ul>`.replace(/\u00a0/g, "&nbsp;");
      await postNote(wizEnv, "account.move", mvId, body);

      destMessages.push((await autoFormatStrings(
        wizEnv,
        escapeText(translate(wizEnv, "Adjusting Entry {link} {percent}%% of {amount} recognized from {date}", "account")),
        fmtOpts,
      )).replace(/\u00a0/g, "&nbsp;"));
      const existing = accrualMoveMessages.get(accMoveId) ?? [];
      existing.push((await autoFormatStrings(
        wizEnv,
        escapeText(translate(wizEnv, "Adjusting Entry {link} {percent}%% of {amount} recognized on {new_date}", "account")),
        fmtOpts,
      )).replace(/\u00a0/g, "&nbsp;"));
      accrualMoveMessages.set(accMoveId, existing);
    }

    if (destMessages.length) {
      await postNote(wizEnv, "account.move", destinationMoveId, `<p>${destMessages.join("<br>\n")}</p>`);
    }
    for (const [amId, msgs] of accrualMoveMessages) {
      await postNote(wizEnv, "account.move", amId, `<p>${msgs.join("<br>\n")}</p>`);
    }

    const treeViewId = await xmlidId(wizEnv, "account.view_move_tree");
    const act: Record<string, unknown> = {
      name: translate(wizEnv, "Generated Entries", "account"),
      domain: [["id", "in", createdMoves]],
      res_model: "account.move",
      view_mode: createdMoves.length === 1 ? "form" : "list,form",
      type: "ir.actions.act_window",
      views: [[treeViewId, "list"], [false, "form"]],
    };
    if (createdMoves.length === 1) act["res_id"] = createdMoves[0]!;
    return act;
  }

  if (action === "change_account") {
    const destAccId = m2oId(await rec.get("destination_account_id"))!;
    const destAccName = (await wizEnv.model("account.account").displayName([destAccId])).get(destAccId) ?? "";
    const [newMoveId] = await create(wizEnv, "account.move", moveVals);
    await postMoves(wizEnv, [newMoveId!], true);

    const newLines = await loadAutoLines(wizEnv, (await wizEnv.cr.query<{ id: number }>(
      "SELECT id FROM account_move_line WHERE move_id = $1 ORDER BY id", [newMoveId])).rows.map((r) => r.id));

    const destLines = srcLines.filter((l) => l.account_id === destAccId);
    const nonDestLines = srcLines.filter((l) => l.account_id !== destAccId);
    const grouped = new Map<string, { partnerId: number | null; currencyId: number; accountId: number; ids: number[] }>();
    for (const l of nonDestLines) {
      const k = `${l.partner_id ?? ""}/${l.currency_id}/${l.account_id}`;
      const g = grouped.get(k);
      if (g) g.ids.push(l.id);
      else grouped.set(k, { partnerId: l.partner_id, currencyId: l.currency_id, accountId: l.account_id, ids: [l.id] });
    }

    const reconciledDestKeys = new Set<string>();
    for (const g of grouped.values()) {
      const matchNew = newLines
        .filter((x) => x.account_id === g.accountId && x.partner_id === g.partnerId && x.currency_id === g.currencyId)
        .map((x) => x.id);
      const toRecIds = [...g.ids, ...matchNew];
      if (toRecIds.length >= 2) {
        const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
        const lRows = await linesById(wizEnv, toRecIds);
        const order = await reconcileLines(wizEnv, lRows, defer);
        await finalizeTracking(wizEnv, { states: defer.states, later: [] }, order);
        for (const fn of [...defer.later, ...(defer.payments ?? [])]) await fn();
      }
      const destKey = `${g.partnerId ?? ""}/${g.currencyId}`;
      if (destLines.length && !reconciledDestKeys.has(destKey)) {
        reconciledDestKeys.add(destKey);
        const matchSrcDest = destLines
          .filter((d) => d.partner_id === g.partnerId && d.currency_id === g.currencyId)
          .map((d) => d.id);
        const matchDest = newLines
          .filter((x) => x.account_id === destAccId && x.partner_id === g.partnerId && x.currency_id === g.currencyId)
          .map((x) => x.id);
        const toRecDest = [...matchSrcDest, ...matchDest];
        if (matchSrcDest.length && matchDest.length && toRecDest.length >= 2) {
          const defer: TrackingDefer = { states: new Map(), later: [], payments: [] };
          const lRows = await linesById(wizEnv, toRecDest);
          const order = await reconcileLines(wizEnv, lRows, defer);
          await finalizeTracking(wizEnv, { states: defer.states, later: [] }, order);
          for (const fn of [...defer.later, ...(defer.payments ?? [])]) await fn();
        }
      }
    }

    // Chatter logs on source moves and new transfer move
    const accTransferPerMove = new Map<number, Map<number, number>>();
    const srcMoveMeta = new Map<number, { name: string | null; date: string }>();
    for (const l of srcLines) {
      srcMoveMeta.set(l.move_id, { name: l.move_name, date: l.move_date });
      let m = accTransferPerMove.get(l.move_id);
      if (!m) { m = new Map(); accTransferPerMove.set(l.move_id, m); }
      m.set(l.account_id, (m.get(l.account_id) ?? 0) + l.balance);
    }
    const allAccIds = [...new Set(srcLines.map((l) => l.account_id))];
    const accNames = allAccIds.length ? await wizEnv.model("account.account").displayName(allAccIds) : new Map<number, string>();
    const newMoveRow = await moveRow(wizEnv, newMoveId!);

    const srcFmt = translate(wizEnv, "{amount} ({debit_credit}) from <strong>{account_source_name}</strong> were transferred to <strong>{account_target_name}</strong> by {link}", "account");
    for (const [mvId, byAcc] of accTransferPerMove) {
      const items: string[] = [];
      for (const [accId, bal] of byAcc) {
        if (accId === destAccId) continue;
        const item = await autoFormatStrings(wizEnv, srcFmt, {
          percentage, wizDate, companyCurrencyId, destAccountName: escapeText(destAccName),
          moveId: newMoveId!, moveName: newMoveRow.name, moveDate: newMoveRow.date,
          amount: bal, accountSourceName: escapeText(accNames.get(accId) ?? ""),
        });
        items.push(`<li>${item}</li>`);
      }
      if (items.length) await postNote(wizEnv, "account.move", mvId, `<ul>${items.join("")}</ul>`.replace(/\u00a0/g, "&nbsp;"));
    }

    const newTransferItems: string[] = [];
    const targetItemFmt = translate(wizEnv, "{amount} ({debit_credit}) from {link}", "account");
    for (const [mvId, byAcc] of accTransferPerMove) {
      const meta = srcMoveMeta.get(mvId)!;
      for (const [accId, bal] of byAcc) {
        if (accId === destAccId) continue;
        const left = await autoFormatStrings(wizEnv, targetItemFmt, {
          percentage, wizDate, companyCurrencyId, destAccountName: destAccName,
          moveId: mvId, moveName: meta.name, moveDate: meta.date, amount: bal,
        });
        newTransferItems.push(`<li>${left}, <strong>${escapeText(accNames.get(accId) ?? "")}</strong></li>`);
      }
    }
    const header = translate(wizEnv, "This entry transfers the following amounts to %(destination)s", "account")
      .replace("%(destination)s", `<strong>${escapeText(destAccName)}</strong>`);
    await postNote(wizEnv, "account.move", newMoveId!, `<p>${header}</p><ul>${newTransferItems.join("")}</ul>`.replace(/\u00a0/g, "&nbsp;"));

    return {
      name: translate(wizEnv, "Transfer", "account"),
      type: "ir.actions.act_window",
      view_mode: "form",
      res_model: "account.move",
      res_id: newMoveId!,
    };
  }

  return null;
});

// =================================================================================================
// 6. account.accrued.orders.wizard (account, sale, purchase wizard/accrued_orders.py)
// =================================================================================================

const ACCRUAL_TYPE_LABELS: Record<string, string> = {
  bill_to_receive: "Bills to receive",
  billed_not_received: "Billed not received",
  invoice_to_be_issued: "Invoices to be issued",
  invoiced_not_delivered: "Invoiced not delivered",
};

export interface AmlVal {
  name: string;
  debit: number;
  credit: number;
  account_id: number;
  analytic_distribution?: Record<string, number>;
  amount_currency?: number;
  currency_id?: number;
  display_type?: string;
}

export function discountedUnitPrice(priceUnit: number, discount: number): number {
  return priceUnit * (1 - (discount || 0) / 100);
}

function makeAccrualAmlVals(
  isPurchase: boolean,
  useOrderCurrency: boolean,
  companyCurrencyId: number,
  orderCurrencyId: number,
  balance0: number,
  amountCurrency0: number,
  accountId: number,
  label: string,
  analyticDistribution?: Record<string, number> | null,
): AmlVal {
  const balance = isPurchase ? balance0 : -balance0;
  const amountCurrency = isPurchase ? amountCurrency0 : -amountCurrency0;
  const values: AmlVal = {
    name: label,
    debit: balance > 0 ? balance : 0.0,
    credit: balance < 0 ? -balance : 0.0,
    account_id: accountId,
  };
  if (analyticDistribution && Object.keys(analyticDistribution).length) {
    values.analytic_distribution = { ...analyticDistribution };
  }
  if (useOrderCurrency && companyCurrencyId !== orderCurrencyId) {
    values.amount_currency = amountCurrency;
    values.currency_id = orderCurrencyId;
  }
  return values;
}

/** account/wizard/accrued_orders.py:157-195 `_merge_aml_vals`. */
export function mergeAccrualAmlVals(valsList: AmlVal[]): AmlVal[] {
  const groups = new Map<string, AmlVal[]>();
  for (const v of valsList) {
    const key = `${v.account_id}/${v.currency_id ?? ""}`;
    const g = groups.get(key);
    if (g) g.push(v); else groups.set(key, [v]);
  }
  const merged: AmlVal[] = [];
  for (const grp of groups.values()) {
    if (grp.length === 1) { merged.push(grp[0]!); continue; }
    const balances = grp.map((v) => v.debit - v.credit);
    const totalBalance = balances.reduce((a, b) => a + b, 0);
    const totalWeight = balances.reduce((a, b) => a + Math.abs(b), 0);
    const ad: Record<string, number> = {};
    for (let i = 0; i < grp.length; i++) {
      const weight = totalWeight ? Math.abs(balances[i]!) / totalWeight : 0.0;
      for (const [k, pct] of Object.entries(grp[i]!.analytic_distribution ?? {})) {
        ad[k] = (ad[k] ?? 0.0) + pct * weight;
      }
    }
    const mv: AmlVal = { ...grp[0]! };
    mv.debit = totalBalance > 0 ? totalBalance : 0.0;
    mv.credit = totalBalance < 0 ? -totalBalance : 0.0;
    if (grp.some((v) => v.amount_currency !== undefined)) {
      mv.amount_currency = grp.reduce((s, v) => s + (v.amount_currency ?? 0), 0);
    }
    if (Object.keys(ad).length) mv.analytic_distribution = ad;
    else delete mv.analytic_distribution;
    merged.push(mv);
  }
  return merged;
}

/** Category hierarchy account fallback (product.py:150-164 `_get_category_account`) + fiscal position map_account. */
async function categoryOrCompanyAccount(
  env: Environment,
  productId: number,
  companyId: number,
  categField: string,
  companyField: string,
  fiscalPosId: number | null,
): Promise<number | null> {
  const cenv = await withCompany(env, companyId);
  const pRow = (await cenv.cr.query<{ tmpl: number }>("SELECT product_tmpl_id AS tmpl FROM product_product WHERE id = $1", [productId])).rows[0];
  if (!pRow) return null;
  const tmpl = new DbRec(cenv, cenv.reg.model("product.template"), pRow.tmpl);
  let account: number | null = null;
  let categ = await tmpl.rel("categ_id");
  while (categ && account === null) {
    account = m2oId(await categ.get(categField));
    categ = await categ.rel("parent_id");
  }
  if (account === null) {
    const owner = m2oId(await tmpl.get("company_id")) ?? companyId;
    account = m2oId(await new DbRec(cenv, cenv.reg.model("res.company"), owner).get(companyField));
  }
  if (account !== null && fiscalPosId) {
    const mapped = (await cenv.cr.query<{ dest: number }>(
      "SELECT account_dest_id AS dest FROM account_fiscal_position_account WHERE position_id = $1 AND account_src_id = $2 LIMIT 1",
      [fiscalPosId, account],
    )).rows[0]?.dest;
    if (mapped) account = mapped;
  }
  return account;
}

async function productMappedAccount(
  env: Environment,
  productId: number,
  companyId: number,
  kind: "income" | "expense" | "stock_valuation",
  fiscalPosId: number | null,
): Promise<number | null> {
  const cenv = await withCompany(env, companyId);
  const prod = new DbRec(cenv, cenv.reg.model("product.product"), productId);
  let account = await productAccountOf(cenv, prod, companyId, kind);
  if (account !== null && fiscalPosId) {
    const mapped = (await cenv.cr.query<{ dest: number }>(
      "SELECT account_dest_id AS dest FROM account_fiscal_position_account WHERE position_id = $1 AND account_src_id = $2 LIMIT 1",
      [fiscalPosId, account],
    )).rows[0]?.dest;
    if (mapped) account = mapped;
  }
  return account;
}

async function computeAccrualMoveVals(
  env: Environment,
  rec: Rec,
): Promise<{ moveVals: Record<string, unknown>; orderLinesWithEntries: number[]; lineModel: "sale.order.line" | "purchase.order.line" }> {
  const activeModel = String(env.context["active_model"] ?? "");
  const activeIds = (env.context["active_ids"] as number[] | undefined) ?? [];
  const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
  const journalId = m2oId(await rec.get("journal_id"));
  const wizDate = String((await rec.get("date")) ?? "");
  const amount = Number((await rec.get("amount")) ?? 0);
  const accountId = m2oId(await rec.get("account_id"));
  const accrualType = String((await rec.get("accrual_type")) ?? "");
  const companyCurrencyId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
  const ccInfo = await currencyInfo(env, companyCurrencyId);

  const isPurchase = activeModel === "purchase.order" || activeModel === "purchase.order.line";
  const orderModel = isPurchase ? "purchase.order" : "sale.order";
  const lineModel = isPurchase ? "purchase.order.line" : "sale.order.line";
  const orderTable = isPurchase ? "purchase_order" : "sale_order";
  const lineTable = isPurchase ? "purchase_order_line" : "sale_order_line";
  const relTable = isPurchase ? "purchase_order_line_accrual_move_rel" : "sale_order_line_accrual_move_rel";

  let orderIds: number[];
  let candidateLineIds: number[];
  if (activeModel === "purchase.order.line" || activeModel === "sale.order.line") {
    candidateLineIds = [...activeIds];
    orderIds = candidateLineIds.length ? [...new Set((await env.cr.query<{ order_id: number }>(
      `SELECT order_id FROM ${lineTable} WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`, [candidateLineIds])).rows.map((r) => r.order_id))] : [];
  } else {
    orderIds = [...activeIds];
    candidateLineIds = orderIds.length ? (await env.cr.query<{ id: number }>(
      `SELECT id FROM ${lineTable} WHERE order_id = ANY($1::int[]) AND product_id IS NOT NULL ORDER BY sequence, id`, [orderIds])).rows.map((r) => r.id) : [];
  }

  const orderRows = orderIds.length ? (await env.cr.query<{
    id: number; name: string; company_id: number; currency_id: number; fiscal_position_id: number | null; amount_total: number;
  }>(
    `SELECT id, name, company_id, currency_id, fiscal_position_id, COALESCE(amount_total, 0)::float8 AS amount_total
       FROM ${orderTable} WHERE id = ANY($1::int[]) ORDER BY array_position($1::int[], id)`,
    [orderIds],
  )).rows : [];

  if (orderRows.some((o) => o.company_id !== companyId)) {
    throw new UserError(translate(env, "Entries can only be created for a single company at a time.", "account"));
  }
  const currencies = [...new Set(orderRows.map((o) => o.currency_id))];
  const mixedCurrencies = currencies.length > 1;
  if (mixedCurrencies && !env.context["accrual_allow_mixed_currencies"]) {
    throw new UserError(translate(env, "Cannot create an accrual entry with orders in different currencies.", "account"));
  }

  const moveLines: unknown[][] = [];
  const orderLinesWithEntries: number[] = [];
  let totalBalance = 0.0;
  let totalAmountCurrency = 0.0;
  const singleOrder = orderRows.length === 1;
  const useOrderCurrency = !mixedCurrencies;
  const displayUom = await userHasGroup(env, "uom.group_uom");
  const today = await contextToday(env);
  const accrualEntryDate = String(env.context["accrual_entry_date"] ?? "") || wizDate;
  const unitDigits = (await env.cr.query<{ d: number }>("SELECT digits AS d FROM decimal_precision WHERE name = 'Product Unit'")).rows[0]?.d ?? 2;

  for (const order of orderRows) {
    const orderCandidateIds = candidateLineIds.length ? (await env.cr.query<{ id: number }>(
      `SELECT id FROM ${lineTable} WHERE order_id = $1 AND id = ANY($2::int[]) ORDER BY sequence, id`,
      [order.id, candidateLineIds],
    )).rows.map((r) => r.id) : [];

    if (singleOrder && orderCandidateIds.length && amount) {
      totalBalance = amount;
      const amountCur = order.currency_id !== companyCurrencyId
        ? await convertAmount(env, amount, companyCurrencyId, order.currency_id, companyId, today)
        : amount;
      totalAmountCurrency = amountCur;
      const l0 = (await env.cr.query<{ product_id: number; analytic_distribution: Record<string, number> | null }>(
        `SELECT product_id, analytic_distribution FROM ${lineTable} WHERE id = $1`, [orderCandidateIds[0]])).rows[0]!;
      const val = await productValuation(await withCompany(env, order.company_id), l0.product_id);
      const kind = isPurchase && val === "real_time" ? "stock_valuation" : (isPurchase ? "expense" : "income");
      const accId = (await productMappedAccount(env, l0.product_id, order.company_id, kind, order.fiscal_position_id)) ?? 0;
      const aml = makeAccrualAmlVals(
        isPurchase, useOrderCurrency, companyCurrencyId, order.currency_id, amount, amountCur, accId,
        translate(env, "Manual entry", "account"), l0.analytic_distribution,
      );
      moveLines.push([0, 0, aml]);
      continue;
    }

    // Automatic accrual calculation for this order's eligible lines
    if (!orderCandidateIds.length) continue;
    const inPast = accrualEntryDate < today;
    const eligibleState = isPurchase ? "purchase" : "sale";
    const uomCol = isPurchase ? "uom_id" : "product_uom_id";
    const qtyDelivCol = isPurchase ? "qty_received" : "qty_delivered";
    const lRows = (await env.cr.query<{
      id: number; name: string | null; product_id: number; product_name: string; product_type: string;
      price_unit: number; discount: number; uom_id: number | null; uom_name: string | null;
      qty_delivered: number; qty_invoiced: number;
      analytic_distribution: Record<string, number> | null;
    }>(
      `SELECT l.id, l.name, l.product_id, COALESCE(pt.name->>$4, pt.name->>'en_US') AS product_name, pt.type AS product_type,
              COALESCE(l.price_unit, 0)::float8 AS price_unit, COALESCE(l.discount, 0)::float8 AS discount,
              l.${uomCol} AS uom_id, COALESCE(u.name->>$4, u.name->>'en_US') AS uom_name,
              COALESCE(l.${qtyDelivCol}, 0)::float8 AS qty_delivered,
              COALESCE(l.qty_invoiced, 0)::float8 AS qty_invoiced,
              l.analytic_distribution
         FROM ${lineTable} l
         JOIN product_product pp ON pp.id = l.product_id
         JOIN product_template pt ON pt.id = pp.product_tmpl_id
         LEFT JOIN uom_uom u ON u.id = l.${uomCol}
        WHERE l.id = ANY($1::int[])
          AND l.state = $2
          AND l.display_type IS NULL
          AND NOT COALESCE(l.is_downpayment, FALSE)
          AND ($3 OR pt.type != 'combo')
          AND NOT EXISTS (
            SELECT 1 FROM ${relTable} rel
              JOIN account_move am ON am.id = rel.move_id
             WHERE rel.order_line_id = l.id
               AND am.state = 'posted'
               AND NOT EXISTS (SELECT 1 FROM account_move rev WHERE rev.reversed_entry_id = am.id)
          )
        ORDER BY l.sequence, l.id`,
      [orderCandidateIds, eligibleState, isPurchase, env.lang ?? "en_US"],
    )).rows;

    const mainVals: AmlVal[] = [];
    const counterpartVals: AmlVal[] = [];
    const cogsVals: AmlVal[] = [];
    const cogsCounterparts: AmlVal[] = [];

    for (const l of lRows) {
      let qtyDoneAtDate = l.qty_delivered;
      let qtyInvAtDate = l.qty_invoiced;
      if (inPast) {
        // Compute invoiced qty up to accrualEntryDate
        if (isPurchase) {
          const invRows = (await env.cr.query<{ qty: number; move_type: string }>(
            `SELECT COALESCE(aml.quantity, 0)::float8 AS qty, am.move_type
               FROM account_move_line aml JOIN account_move am ON am.id = aml.move_id
              WHERE aml.purchase_line_id = $1 AND (am.state != 'cancel' OR am.payment_state = 'invoicing_legacy')
                AND am.invoice_date IS NOT NULL AND am.invoice_date <= $2::date`,
            [l.id, accrualEntryDate],
          )).rows;
          qtyInvAtDate = invRows.reduce((s, r) => s + (r.move_type === "in_refund" ? -r.qty : r.qty), 0);
        } else {
          const invRows = (await env.cr.query<{ qty: number; move_type: string }>(
            `SELECT COALESCE(aml.quantity, 0)::float8 AS qty, am.move_type
               FROM sale_order_line_invoice_rel rel
               JOIN account_move_line aml ON aml.id = rel.invoice_line_id
               JOIN account_move am ON am.id = aml.move_id
              WHERE rel.order_line_id = $1 AND (am.state != 'cancel' OR am.payment_state = 'invoicing_legacy')
                AND am.invoice_date IS NOT NULL AND am.invoice_date <= $2::date`,
            [l.id, accrualEntryDate],
          )).rows;
          qtyInvAtDate = invRows.reduce((s, r) => s + (r.move_type === "out_refund" ? -r.qty : r.qty), 0);
        }
        // Compute stock delivered/received qty up to accrualEntryDate if stock moves exist
        const fkCol = isPurchase ? "purchase_line_id" : "sale_line_id";
        const smRows = (await env.cr.query<{ qty: number; src_usage: string; dst_usage: string }>(
          `SELECT COALESCE(sm.quantity, 0)::float8 AS qty, ls.usage AS src_usage, ld.usage AS dst_usage
             FROM stock_move sm
             JOIN stock_location ls ON ls.id = sm.location_id
             JOIN stock_location ld ON ld.id = sm.location_dest_id
            WHERE sm.${fkCol} = $1 AND sm.state = 'done' AND sm.date <= ($2::date + interval '1 day' - interval '1 second')`,
          [l.id, accrualEntryDate],
        )).rows;
        if (smRows.length) {
          qtyDoneAtDate = smRows.reduce((s, r) => {
            if (isPurchase) return s + (r.dst_usage === "supplier" ? -r.qty : r.qty);
            return s + (r.src_usage === "customer" ? -r.qty : r.qty);
          }, 0);
        }
      }

      const unitPriceDisc = discountedUnitPrice(l.price_unit, l.discount);
      const qtyToInv = qtyDoneAtDate - qtyInvAtDate;
      const amountToInv = qtyToInv * unitPriceDisc;
      if (floatRound(amountToInv, unitDigits) === 0) continue;
      orderLinesWithEntries.push(l.id);

      const lineLabel = ellipsis(l.name || l.product_name, 20);
      const orderCurInfo = await currencyInfo(env, order.currency_id);
      const val = await productValuation(await withCompany(env, order.company_id), l.product_id);

      if (isPurchase) {
        let priceUnit = unitPriceDisc;
        if (qtyToInv < 0) {
          const postedInv = (await env.cr.query<{ ps: number }>(
            `SELECT COALESCE(aml.price_subtotal, 0)::float8 AS ps
               FROM account_move_line aml JOIN account_move am ON am.id = aml.move_id
              WHERE aml.purchase_line_id = $1 AND am.state = 'posted' AND aml.date <= $2::date`,
            [l.id, accrualEntryDate],
          )).rows;
          const invoicedVal = postedInv.reduce((s, r) => s + r.ps, 0);
          const receivedVal = qtyDoneAtDate * unitPriceDisc;
          priceUnit = -(invoicedVal - receivedVal) / qtyToInv;
        }
        const amtCur = curRound(qtyToInv * priceUnit, orderCurInfo.places);
        const amt = order.currency_id !== companyCurrencyId
          ? await convertAmount(env, amtCur, order.currency_id, companyCurrencyId, companyId, today)
          : amtCur;
        const qBilled = displayUom && l.uom_name ? `${qtyInvAtDate} ${l.uom_name}` : String(qtyInvAtDate);
        const qReceived = displayUom && l.uom_name ? `${qtyDoneAtDate} ${l.uom_name}` : String(qtyDoneAtDate);
        const label = translate(env, "%(order)s - %(order_line)s; %(quantity_billed)s Billed, %(quantity_received)s Received at %(unit_price)s each", "purchase")
          .replace("%(order)s", order.name)
          .replace("%(order_line)s", lineLabel)
          .replace("%(quantity_billed)s", qBilled)
          .replace("%(quantity_received)s", qReceived)
          .replace("%(unit_price)s", await formatLangCurrency(env, priceUnit, order.currency_id));

        const accrualAccId = accountId ?? (await categoryOrCompanyAccount(
          env, l.product_id, order.company_id,
          qtyToInv > 0 ? "property_account_bills_to_receive_id" : "property_account_billed_not_received_id",
          qtyToInv > 0 ? "account_bills_to_receive_id" : "account_billed_not_received_id",
          order.fiscal_position_id,
        )) ?? 0;

        if (val === "real_time") {
          const svAccId = (await productMappedAccount(env, l.product_id, order.company_id, "stock_valuation", order.fiscal_position_id)) ?? 0;
          cogsVals.push(makeAccrualAmlVals(true, useOrderCurrency, companyCurrencyId, order.currency_id, amt, amtCur, svAccId, label, l.analytic_distribution));
          cogsCounterparts.push(makeAccrualAmlVals(true, useOrderCurrency, companyCurrencyId, order.currency_id, -amt, -amtCur, accrualAccId, translate(env, "Accrued total", "account"), l.analytic_distribution));
        } else if (!curIsZero(amt, ccInfo.rounding)) {
          const expAccId = (await productMappedAccount(env, l.product_id, order.company_id, "expense", order.fiscal_position_id)) ?? 0;
          mainVals.push(makeAccrualAmlVals(true, useOrderCurrency, companyCurrencyId, order.currency_id, amt, amtCur, expAccId, label, l.analytic_distribution));
          counterpartVals.push(makeAccrualAmlVals(true, useOrderCurrency, companyCurrencyId, order.currency_id, -amt, -amtCur, accrualAccId, translate(env, "Accrued total", "account"), l.analytic_distribution));
        }
      } else {
        // Sale order line
        let priceUnit = unitPriceDisc;
        let amtCur: number;
        let amt: number;
        if (qtyToInv > 0) {
          amtCur = amountToInv;
          amt = order.currency_id !== companyCurrencyId
            ? await convertAmount(env, amtCur, order.currency_id, companyCurrencyId, companyId, today)
            : amtCur;
        } else {
          amtCur = 0; amt = 0;
          let processed = 0;
          const postedInv = (await env.cr.query<{ ps: number; qty: number }>(
            `SELECT COALESCE(aml.price_subtotal, 0)::float8 AS ps, COALESCE(aml.quantity, 0)::float8 AS qty
               FROM sale_order_line_invoice_rel rel
               JOIN account_move_line aml ON aml.id = rel.invoice_line_id
               JOIN account_move am ON am.id = aml.move_id
              WHERE rel.order_line_id = $1 AND am.state = 'posted'
              ORDER BY aml.date DESC, aml.move_name DESC, aml.id DESC`,
            [l.id],
          )).rows;
          for (const ivl of postedInv) {
            amtCur -= ivl.ps;
            amt -= order.currency_id !== companyCurrencyId
              ? await convertAmount(env, ivl.ps, order.currency_id, companyCurrencyId, companyId, today)
              : ivl.ps;
            processed += ivl.qty;
            if (processed >= Math.abs(qtyToInv)) break;
          }
          if (processed) priceUnit = Math.abs(amt / processed);
        }
        if (!curIsZero(amt, ccInfo.rounding)) {
          const incAccId = (await productMappedAccount(env, l.product_id, order.company_id, "income", order.fiscal_position_id)) ?? 0;
          const accrualAccId = accountId ?? (await categoryOrCompanyAccount(
            env, l.product_id, order.company_id,
            qtyToInv > 0 ? "property_account_invoices_to_issue_id" : "property_account_invoiced_not_delivered_id",
            qtyToInv > 0 ? "account_invoices_to_issue_id" : "account_invoiced_not_delivered_id",
            order.fiscal_position_id,
          )) ?? 0;
          const qInv = displayUom && l.uom_name ? `${qtyInvAtDate} ${l.uom_name}` : String(qtyInvAtDate);
          const qDel = displayUom && l.uom_name ? `${qtyDoneAtDate} ${l.uom_name}` : String(qtyDoneAtDate);
          const label = translate(env, "%(order)s - %(order_line)s; %(quantity_invoiced)s Invoiced, %(quantity_delivered)s Delivered at %(unit_price)s each", "sale")
            .replace("%(order)s", order.name)
            .replace("%(order_line)s", lineLabel)
            .replace("%(quantity_invoiced)s", qInv)
            .replace("%(quantity_delivered)s", qDel)
            .replace("%(unit_price)s", await formatLangCurrency(env, priceUnit, order.currency_id));
          mainVals.push(makeAccrualAmlVals(false, useOrderCurrency, companyCurrencyId, order.currency_id, amt, amtCur, incAccId, label, l.analytic_distribution));
          counterpartVals.push(makeAccrualAmlVals(false, useOrderCurrency, companyCurrencyId, order.currency_id, -amt, -amtCur, accrualAccId, translate(env, "Accrued total", "account"), l.analytic_distribution));
        }
      }
    }

    for (const v of [...mainVals, ...cogsVals, ...mergeAccrualAmlVals(counterpartVals), ...mergeAccrualAmlVals(cogsCounterparts)]) {
      moveLines.push([0, 0, v]);
    }
  }

  // Manual amount globalized counterpart
  if (!curIsZero(totalBalance, ccInfo.rounding)) {
    const ad: Record<string, number> = {};
    const total = orderRows.reduce((s, o) => s + o.amount_total, 0);
    if (orderIds.length) {
      const allOrderLines = (await env.cr.query<{ price_total: number; analytic_distribution: Record<string, number> | null }>(
        `SELECT COALESCE(price_total, 0)::float8 AS price_total, analytic_distribution FROM ${lineTable} WHERE order_id = ANY($1::int[]) ORDER BY id`,
        [orderIds],
      )).rows;
      for (const ol of allOrderLines) {
        if (!ol.analytic_distribution) continue;
        const ratio = total ? ol.price_total / total : 0.0;
        for (const [k, v] of Object.entries(ol.analytic_distribution)) {
          ad[k] = (ad[k] ?? 0) + v * ratio;
        }
      }
    }
    const orderCur = orderRows[0]?.currency_id ?? companyCurrencyId;
    const cp = makeAccrualAmlVals(
      isPurchase, useOrderCurrency, companyCurrencyId, orderCur, -totalBalance, -totalAmountCurrency, accountId ?? 0,
      translate(env, "Accrued total", "account"), ad,
    );
    moveLines.push([0, 0, cp]);
  }

  let ref: string | null = null;
  const typeLabel = ACCRUAL_TYPE_LABELS[accrualType];
  if (typeLabel) {
    const dateStr = wizDate ? await formatDate(env, wizDate) : "";
    ref = translate(env, "%(accrual_type)s entry as of %(date)s", "account")
      .replace("%(accrual_type)s", translate(env, typeLabel, "account"))
      .replace("%(date)s", dateStr);
  }
  const currencyId = mixedCurrencies ? companyCurrencyId : (currencies[0] ?? companyCurrencyId);

  return {
    moveVals: {
      ref,
      name: "/",
      journal_id: journalId ?? false,
      date: wizDate,
      line_ids: moveLines,
      currency_id: currencyId,
    },
    orderLinesWithEntries,
    lineModel,
  };
}

/** Reverse a journal entry move without posting immediately (`auto_post='at_date'`), matching `_reverse_moves` for accruals. */
async function createAccrualReverseMove(
  env: Environment,
  srcMoveId: number,
  vals: { ref: string; date: string; auto_post: string },
): Promise<number> {
  const src = (await env.cr.query<{ r: Row }>("SELECT row_to_json(m) AS r FROM account_move m WHERE id = $1", [srcMoveId])).rows[0]!.r;
  const srcLines = (await env.cr.query<{ r: Row }>("SELECT row_to_json(l) AS r FROM account_move_line l WHERE move_id = $1 ORDER BY id", [srcMoveId])).rows.map((x) => x.r);
  const skip = new Set(["id", "create_uid", "write_uid", "create_date", "write_date"]);
  const mv: Row = {};
  for (const [k, v] of Object.entries(src)) {
    if (!skip.has(k)) mv[k] = v !== null && typeof v === "object" ? JSON.stringify(v) : v;
  }
  Object.assign(mv, {
    reversed_entry_id: srcMoveId,
    name: "/",
    state: "draft",
    posted_before: null,
    ref: vals.ref,
    date: vals.date,
    invoice_date: null,
    invoice_date_due: null,
    auto_post: vals.auto_post,
    payment_state: "not_paid",
    sequence_prefix: "",
    sequence_number: 0,
    made_sequence_gap: false,
    access_token: null,
    message_main_attachment_id: null,
    has_grouped_lines: false,
    quick_edit_total_amount: 0,
    is_move_sent: null,
    inalterable_hash: null,
    secure_sequence_number: null,
    sending_data: null,
    peppol_message_uuid: null,
    peppol_move_state: null,
    is_manually_modified: true,
  });
  const revId = await insertRow(env, "account_move", mv);
  for (const l of srcLines) {
    const lv: Row = {};
    for (const [k, x] of Object.entries(l)) {
      if (!skip.has(k)) lv[k] = x !== null && typeof x === "object" ? JSON.stringify(x) : x;
    }
    const b = -Number(l["balance"]);
    const c = -Number(l["amount_currency"]);
    Object.assign(lv, {
      move_id: revId,
      move_name: "/",
      ref: vals.ref,
      date: vals.date,
      parent_state: "draft",
      balance: b,
      amount_currency: c,
      debit: b > 0 ? b : 0,
      credit: b < 0 ? -b : 0,
      amount_residual: b,
      amount_residual_currency: c,
      reconciled: false,
      full_reconcile_id: null,
      matching_number: null,
      price_subtotal: -Number(l["price_subtotal"] ?? 0),
      price_total: -Number(l["price_total"] ?? 0),
      collapse_composition: false,
      collapse_prices: false,
      is_downpayment: false,
      is_imported: false,
      tax_base_amount: 0,
      discount_amount_currency: 0,
      discount_balance: 0,
    });
    await insertRow(env, "account_move_line", lv);
  }
  await mailAfterCreate(env, "account.move", [revId], [{ move_type: "entry", partner_id: false, journal_id: src["journal_id"] }]);
  const link = await moveHtmlLink(env, srcMoveId);
  const from = translate(env, "This entry has been reversed from %s", "account").replace("%s", () => link);
  await messageLogBatch(env, "account.move", new Map([[revId, `<p>${from}</p>`]]));
  return revId;
}

/** account_move.py:5951-5968 `_unlink_or_reverse`. */
async function unlinkOrReverseMoves(env: Environment, moveIds: readonly number[]): Promise<void> {
  if (!moveIds.length) return;
  const rows = (await env.cr.query<{
    id: number; state: string; posted_before: boolean | null; inalterable_hash: string | null;
    date: string; company_id: number; restrictive_audit_trail: boolean | null;
  }>(
    `SELECT m.id, m.state, m.posted_before, m.inalterable_hash, m.date::text AS date,
            m.company_id, co.restrictive_audit_trail
       FROM account_move m JOIN res_company co ON co.id = m.company_id
      WHERE m.id = ANY($1::int[]) ORDER BY array_position($1::int[], m.id)`,
    [[...moveIds]],
  )).rows;

  const toUnlink: number[] = [];
  const toUnlinkPostedOrCancel: number[] = [];
  const toCancel: number[] = [];
  for (const r of rows) {
    let canUnlink = true;
    if (r.posted_before) {
      const fiscalLock = await userLockDate(env, r.company_id, "fiscalyear_lock_date");
      canUnlink = !r.inalterable_hash && (fiscalLock === DATE_MIN || r.date > fiscalLock);
    }
    if (!canUnlink) {
      throw new NotPorted("_unlink_or_reverse of a locked/hashed accrual duplicate move");
    } else if (r.posted_before && r.restrictive_audit_trail) {
      toCancel.push(r.id);
    } else {
      toUnlink.push(r.id);
      if (r.state === "posted" || r.state === "cancel") toUnlinkPostedOrCancel.push(r.id);
    }
  }
  if (toUnlinkPostedOrCancel.length) {
    await buttonDraft(env, toUnlinkPostedOrCancel, true);
  }
  if (toUnlink.length) {
    await unlink(env, "account.move", toUnlink);
  }
  if (toCancel.length) {
    const cancelDrafts = rows.filter((r) => toCancel.includes(r.id) && r.state === "posted").map((r) => r.id);
    if (cancelDrafts.length) await buttonDraft(env, cancelDrafts, false);
    await write(env, "account.move", toCancel, { auto_post: "no", state: "cancel" });
    await env.cr.query("UPDATE account_move_line SET parent_state = 'cancel' WHERE move_id = ANY($1::int[])", [toCancel]);
  }
}

registerDefaults("account.accrued.orders.wizard", {
  company_id: async (env) => {
    const activeModel = env.context["active_model"];
    const activeIds = env.context["active_ids"] as number[] | undefined;
    if (typeof activeModel !== "string" || !activeModel || !activeIds?.length) return false;
    const tbl = env.reg.model(activeModel).table;
    const row = (await env.cr.query<{ c: number | null }>(`SELECT company_id AS c FROM "${tbl}" WHERE id = $1`, [activeIds[0]])).rows[0];
    return row?.c ?? false;
  },
  date: async (env) => {
    const today = await contextToday(env);
    // First day of current month minus 1 day = last day of previous month
    const firstOfMonth = `${today.slice(0, 7)}-01`;
    return addDays(firstOfMonth, -1);
  },
});

registerRecordCompute("account.accrued.orders.wizard", {
  journal_id: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const ids = await env.model("account.journal").search(
      and([cond("company_id", "parent_of", [companyId]), cond("type", "=", "general")]),
      { limit: 1 },
    );
    return ids[0] ?? false;
  },
  reversal_date: async (_env, rec) => {
    const d = (await rec.get("date")) as string | false | null;
    const prev = (await rec.prev("reversal_date")) as string | false | null;
    if (d && (!prev || prev <= d)) return addDays(d, 1);
    return prev ?? false;
  },
});

defineComputes("account.accrued.orders.wizard", {
  preview_data: async (env, rec) => {
    const companyId = m2oId(await rec.get("company_id")) ?? await env.company();
    const curId = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [companyId])).rows[0]!.c;
    const { moveVals } = await computeAccrualMoveVals(env, rec);
    const previewVals = [await moveDictToPreviewVals(env, moveVals, curId)];
    const previewColumns = [
      { field: "account_id", label: translate(env, "Account", "account") },
      { field: "name", label: translate(env, "Label", "account") },
      { field: "debit", label: translate(env, "Debit", "account"), class: "text-end text-nowrap" },
      { field: "credit", label: translate(env, "Credit", "account"), class: "text-end text-nowrap" },
    ];
    return pyJsonDumps({
      groups_vals: previewVals,
      options: { columns: previewColumns },
    });
  },
  display_amount: async (env, rec) => {
    const activeIds = (env.context["active_ids"] as number[] | undefined) ?? [];
    const singleOrder = activeIds.length === 1;
    const amt = Number((await rec.get("amount")) ?? 0);
    if (amt) return true;
    const raw = (await rec.get("preview_data")) as string | false | null;
    if (!raw) return singleOrder;
    const parsed = JSON.parse(raw) as { groups_vals?: { items_vals?: unknown[] }[] };
    const lines = parsed.groups_vals?.[0]?.items_vals ?? [];
    return singleOrder && lines.length === 0;
  },
  duplicate_entry_id: async (env, rec) => {
    const raw = (await rec.get("preview_data")) as string | false | null;
    if (!raw) return false;
    const parsed = JSON.parse(raw) as { groups_vals?: { group_name?: string }[] };
    const groupName = parsed.groups_vals?.[0]?.group_name ?? "";
    const parts = groupName.split(", ");
    const ref = parts[1];
    const date = (await rec.get("date")) as string | false | null;
    const journalId = m2oId(await rec.get("journal_id"));
    if (!date || !journalId || ref === undefined) return false;
    const found = await env.model("account.move").search(
      and([
        cond("date", "=", date),
        cond("journal_id", "=", journalId),
        cond("ref", "=", ref),
        cond("state", "in", ["draft", "posted"]),
      ]),
      { order: "id desc", limit: 1 },
    );
    return found[0] ?? false;
  },
});

btn("account.accrued.orders.wizard", "open_duplicate", async (env, ids) => {
  const wizId = ensureOne(ids, "account.accrued.orders.wizard");
  const rec = new DbRec(env, env.reg.model("account.accrued.orders.wizard"), wizId);
  const dupId = m2oId(await rec.get("duplicate_entry_id"));
  if (!dupId) return null;
  return {
    type: "ir.actions.act_window",
    name: "Duplicate Entry",
    res_model: "account.move",
    res_id: dupId,
    view_mode: "form",
    target: "current",
  };
});

btn("account.accrued.orders.wizard", "create_entries", async (env, ids, args, kwargs) => {
  const wizId = ensureOne(ids, "account.accrued.orders.wizard");
  const autoPost = args.length ? Boolean(args[0]) : ("auto_post" in kwargs ? Boolean(kwargs["auto_post"]) : true);
  const rec = new DbRec(env, env.reg.model("account.accrued.orders.wizard"), wizId);
  const date = String((await rec.get("date")) ?? "");
  const reversalDate = String((await rec.get("reversal_date")) ?? "");
  if (reversalDate <= date) {
    throw new UserError(translate(env, "Reversal date must be posterior to date.", "account"));
  }

  // Unlink or reverse duplicate entry and its reversal if present
  const dupId = m2oId(await rec.get("duplicate_entry_id"));
  if (dupId) {
    const revDupIds = await env.model("account.move").search(cond("reversed_entry_id", "=", dupId));
    await unlinkOrReverseMoves(env, [dupId, ...revDupIds]);
  }

  const { moveVals, orderLinesWithEntries, lineModel } = await computeAccrualMoveVals(env, rec);
  const [moveId] = await create(env, "account.move", [moveVals]);
  if (orderLinesWithEntries.length) {
    const relTable = lineModel === "purchase.order.line"
      ? "purchase_order_line_accrual_move_rel"
      : "sale_order_line_accrual_move_rel";
    for (const olId of orderLinesWithEntries) {
      await env.cr.query(
        `INSERT INTO ${relTable} (order_line_id, move_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [olId, moveId],
      );
    }
  }

  const moveRef = moveVals["ref"] === null || moveVals["ref"] === undefined ? "False" : String(moveVals["ref"]);
  const revRef = translate(env, "Reversal of: %s", "account").replace("%s", () => moveRef);
  const reverseMoveId = await createAccrualReverseMove(env, moveId!, {
    ref: revRef,
    date: reversalDate,
    auto_post: "at_date",
  });

  if (autoPost) {
    await postMoves(env, [moveId!], true);
  }

  return {
    name: translate(env, "Accrual Moves", "account"),
    type: "ir.actions.act_window",
    res_model: "account.move",
    view_mode: "list,form",
    domain: [["id", "in", [moveId!, reverseMoveId]]],
  };
});
