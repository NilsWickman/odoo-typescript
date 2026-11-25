/**
 * Header buttons of the account.move and account.payment forms (`/web/dataset/call_button`), as far as the API
 * corpus reaches them in poc_erp. Every branch that would need more of Odoo (posting, reset to draft, cancel,
 * hashing, payment transactions) raises NotPorted. Rows in worker/COMPUTED.md.
 */
import { AccessError, MissingError, NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { pyFloatRepr } from "../http/json";
import { userHasGroup } from "../web/groups";
import { write } from "../orm/write";
import { DbRec, registerOnchange } from "../orm/recompute";
import { buttonDraft, postDrafts } from "./account_move_ops";
import { contextToday } from "./account_computes";
import type { Environment } from "../orm/types";
import { langOf, translate } from "./util";
import { escapeText, messageLogBatch } from "../mail/message";
import { formatDate } from "./account_locks";
import { redateTerms } from "./account_move_create";
import * as priv from "../orm/dispatch_gen";

/**
 * `record.field` on a recordset (fields.py `__get__` -> models.py `_fetch_field`): read access first
 * (AccessError), then a missing id raises MissingError (models.py `_fetch_query`). `read()` filters missing ids, so
 * they are detected here.
 */
export async function fetchRecords(env: Environment, model: string, ids: readonly number[], fields: readonly string[]): Promise<Record<string, unknown>[]> {
  const rows = await env.model(model).read(ids, fields, "");
  const found = new Set(rows.map((r) => Number(r["id"])));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length) {
    throw new MissingError(`Record does not exist or has been deleted.\n(Record: ${model}(${missing.join(", ")},), User: ${env.uid})`);
  }
  const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
  return ids.map((id) => byId.get(id)!);
}

function ensureOne(ids: readonly number[] | null, model: string): number {
  // models.py ensure_one: ValueError("Expected singleton: %s" % self)
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on ${model}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

function m2oId(v: unknown): number | null {
  if (Array.isArray(v)) return typeof v[0] === "number" ? v[0] : null;
  return typeof v === "number" && v > 0 ? v : null;
}

export async function forXmlId(env: Environment, xmlid: string): Promise<Record<string, unknown>> {
  // ir_actions.py:206-226 `_for_xml_id` -> `_get_action_dict`: the dict /web/action/load returns
  const { loadAction } = await import("../controllers/action");
  return loadAction({ cursor: () => env.cr, context: env.context, uid: env.uid }, xmlid);
}

/** environments.py:182-185 is_admin -> res_users.py:1292-1294 `_is_admin`. */
export async function isAdmin(env: Environment): Promise<boolean> {
  return env.su || env.uid === 1 || await userHasGroup(env.sudo(), "base.group_erp_manager");
}

export async function companyHasLayout(env: Environment): Promise<boolean> {
  const r = await env.cr.query<{ l: number | null }>("SELECT external_report_layout_id AS l FROM res_company WHERE id = $1", [await env.company()]);
  return r.rows[0]?.l != null;
}

/** ir_actions_report.py:896-902 `_action_configure_external_report_layout`. */
export async function configureExternalReportLayout(env: Environment, reportAction: Record<string, unknown>, xmlid = "web.action_base_document_layout_configurator"): Promise<Record<string, unknown>> {
  const action = await forXmlId(env, xmlid);
  const raw = action["context"];
  const pyCtx = JSON.parse(typeof raw === "string" ? raw : "{}") as Record<string, unknown>;
  reportAction["close_on_report_download"] = true;
  pyCtx["report_action"] = reportAction;
  action["context"] = pyCtx;
  return action;
}

/** ir_actions_report.py:863-894 report_action(docids, data=None, config). */
export async function reportAction(env: Environment, reportId: number, docids: readonly number[], config = true): Promise<Record<string, unknown>> {
  const row = (await env.cr.query<{ name: Record<string, string> | string; report_name: string; report_type: string }>(
    "SELECT name, report_name, report_type FROM ir_act_report_xml WHERE id = $1", [reportId])).rows[0];
  if (row === undefined) throw new MissingError(`Record does not exist or has been deleted.\n(Record: ir.actions.report(${reportId},), User: ${env.uid})`);
  const name = typeof row.name === "string" ? row.name : (row.name[langOf(env)] ?? row.name["en_US"] ?? "");
  const context = docids.length ? { ...env.context, active_ids: [...docids] } : env.context;
  const action: Record<string, unknown> = { context, data: null, type: "ir.actions.report", report_name: row.report_name, report_type: row.report_type, name };
  if (await isAdmin(env) && !(await companyHasLayout(env)) && config && !env.context["discard_logo_check"]) {
    return configureExternalReportLayout(env, action);
  }
  return action;
}

export async function xmlidId(env: Environment, xmlid: string): Promise<number> {
  const [module, name] = xmlid.split(".");
  const r = await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = $1 AND name = $2", [module, name]);
  if (!r.rows[0]) throw new NotPorted(`env.ref(${xmlid}) missing`);
  return r.rows[0].res_id;
}

/** account_move.py:7328-7343 `_get_action_with_base_document_layout_configurator`. */
async function withLayoutConfigurator(env: Environment, moveType: string, report: Record<string, unknown>): Promise<Record<string, unknown>> {
  if ((await isAdmin(env) || await userHasGroup(env, "account.group_account_basic")) && !(await companyHasLayout(env)) && !env.context["discard_logo_check"]) {
    const action = await configureExternalReportLayout(env, report, "account.action_base_document_layout_configurator");
    const ctx = action["context"] as Record<string, unknown>;
    ctx["can_configure_later"] = true;
    ctx["default_from_invoice"] = moveType === "out_invoice";
    return action;
  }
  return report;
}

const SALE_TYPES = ["out_invoice", "out_refund", "out_receipt"];

/**
 * account_peppol/models/account_move.py:69-72 action_send_and_print (the partner endpoint check,
 * res_partner.py:229-251, returns early without a routing identifier) -> account_move.py:6750-6762, with
 * account_move_send.py:333-345 `_check_move_constraints` (account_edi_ubl_cii :24-28 only relaxes self-invoices).
 */
async function actionSendAndPrint(env: Environment, ids: readonly number[]): Promise<Record<string, unknown>> {
  const moves = await fetchRecords(env, "account.move", ids, ["commercial_partner_id", "company_id", "state", "move_type"]);
  for (const m of moves) {
    const partner = m2oId(m["commercial_partner_id"]);
    if (partner === null) throw new NotPorted("button_account_peppol_check_partner_endpoint on no partner (ensure_one)");
    await checkPeppolPartnerEndpoint(env, partner, Number(m2oId(m["company_id"]))); // account_peppol account_move.py:69-72
  }
  for (const m of moves) {
    // the first constraint in insertion order
    if (m["state"] !== "posted") throw new UserError(translate(env, "You can't generate invoices that are not posted."));
    if (!SALE_TYPES.includes(String(m["move_type"]))) throw new NotPorted("_get_move_constraints of a purchase document (_is_exportable_as_self_invoice)");
  }
  return {
    name: translate(env, "Send", "account"), // account_move.py:6753 `_("Send")` (account's sv: "Ingående")
    type: "ir.actions.act_window",
    view_mode: "form",
    res_model: ids.length === 1 ? "account.move.send.wizard" : "account.move.send.batch.wizard",
    target: "new",
    context: { active_model: "account.move", active_ids: [...ids] },
  };
}

/** account_move.py:6764-6772 action_invoice_sent. */
registerMethod("account.move", "action_invoice_sent", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const report = await actionSendAndPrint(env, [id]);
  (report["context"] as Record<string, unknown>)["allow_partners_without_mail"] = true;
  const [move] = await fetchRecords(env, "account.move", [id], ["move_type"]);
  return withLayoutConfigurator(env, String(move!["move_type"]), report);
}, { apiModel: false });

/**
 * account_move.py:6799-6803 action_print_pdf, with account_move_send.py:50-62 `_get_default_pdf_report_id` (the
 * company-dependent templates of the partner and the journal, else account.account_invoices when available,
 * account_move.py:7256-7264).
 */
export async function defaultPdfReport(env: Environment, id: number): Promise<number> {
  const [move] = await fetchRecords(env, "account.move", [id], ["commercial_partner_id", "journal_id", "company_id"]);
  const company = m2oId(move!["company_id"]);
  const cenv = company === null ? env : env.withContext({ ...env.context, allowed_company_ids: [company] });
  let report: number | null = null;
  const partner = m2oId(move!["commercial_partner_id"]);
  if (partner !== null) report = m2oId((await cenv.model("res.partner").read([partner], ["invoice_template_pdf_report_id"], ""))[0]?.["invoice_template_pdf_report_id"]);
  if (report === null) {
    const journal = m2oId(move!["journal_id"]);
    if (journal !== null) report = m2oId((await cenv.model("account.journal").read([journal], ["invoice_template_pdf_report_id"], ""))[0]?.["invoice_template_pdf_report_id"]);
  }
  if (report === null) {
    const fallback = await xmlidId(env, "account.account_invoices");
    const r = (await env.cr.query<{ is_invoice_report: boolean | null; domain: string | null }>(
      "SELECT is_invoice_report, domain FROM ir_act_report_xml WHERE id = $1", [fallback])).rows[0];
    if (!r?.is_invoice_report) throw new UserError(translate(env, "There is no template that applies to this move type."));
    if (r.domain && r.domain.trim() !== "[]") throw new NotPorted("_is_action_report_available with a report domain (filtered_domain)");
    report = fallback;
  }
  return report;
}

registerMethod("account.move", "action_print_pdf", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], ["move_type"]);
  const report = await defaultPdfReport(env, id);
const action = await reportAction(env, report, [id], false);
  return withLayoutConfigurator(env, String(move!["move_type"]), action);
}, { apiModel: false });

const INVOICE_TYPES = ["out_invoice", "out_refund", "in_invoice", "in_refund"];
const RECEIPT_TYPES = ["out_receipt", "in_receipt"];

// ---------------------------------------------------------------------------------------------------------------
// account.move

/**
 * account_move.py:6728-6738 action_register_payment -> action_force_register_payment ->
 * account_move_line.py:1729-1749 action_register_payment on `self.line_ids`.
 */
registerMethod("account.move", "action_register_payment", async (env, ids) => {
  const moves = await fetchRecords(env, "account.move", ids ?? [], ["state", "move_type", "payment_state", "line_ids"]);
  if (moves.some((m) => m["state"] !== "posted")) throw new UserError(translate(env, "You can only register payment for posted journal entries."));
  if (moves.some((m) => m["move_type"] === "entry")) throw new UserError(translate(env, "You cannot register payments for miscellaneous entries."));
  if (moves.some((m) => m["payment_state"] === "blocked")) throw new UserError(translate(env, "You cannot register payments for blocked invoices."));
  const lineIds: number[] = [];
  for (const m of moves) for (const id of (m["line_ids"] as number[]) ?? []) if (!lineIds.includes(id)) lineIds.push(id);
  if (moves.length > 1) throw new NotPorted("action_register_payment on several moves (line_ids union in the move_line _order)");
  return {
    name: translate(env, "Pay"),
    res_model: "account.payment.register",
    view_mode: "form",
    views: [[false, "form"]],
    context: { active_model: "account.move.line", active_ids: lineIds },
    target: "new",
    type: "ir.actions.act_window",
  };
}, { apiModel: false });

/** account_move.py:6813-6819 action_reverse. */
registerMethod("account.move", "action_reverse", async (env, ids) => {
  const action = await forXmlId(env, "account.action_view_account_move_reversal");
  // `if self.is_invoice()`: on a recordset of several moves `self.move_type` raises (ensure_one in the getter)
  if ((ids ?? []).length > 1) throw new NotPorted("action_reverse on several moves (is_invoice on a recordset)");
  if (ids && ids.length === 1) {
    const [move] = await fetchRecords(env, "account.move", ids, ["move_type"]);
    if (INVOICE_TYPES.includes(String(move!["move_type"]))) action["name"] = translate(env, "Credit Note");
  }
  return action;
}, { apiModel: false });

/**
 * account_move.py:6805-6811 preview_invoice -> portal_mixin.py:121-146 get_portal_url (share_token=True) with
 * :34-39 `_portal_ensure_token` (a sudo write of a uuid4 when the move has no token).
 */
registerMethod("account.move", "preview_invoice", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  const [move] = await fetchRecords(env, "account.move", [id], ["access_url", "access_token"]);
  let token = move!["access_token"];
  if (!token) {
    token = crypto.randomUUID();
    await write(env.sudo(), "account.move", [id], { access_token: token });
  }
  return { type: "ir.actions.act_url", target: "new", url: `${String(move!["access_url"])}?access_token=${String(token)}` };
}, { apiModel: false });

/** Transactions of the moves (account_payment/models/account_move.py `transaction_ids`, a many2many). */
async function transactionCount(env: Environment, ids: readonly number[]): Promise<number> {
  const r = await env.cr.query<{ n: string }>("SELECT count(*) AS n FROM account_invoice_transaction_rel WHERE invoice_id = ANY($1::int[])", [ids]);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * account_payment/models/account_move.py:104-110 payment_action_capture: ensure_one, check_access('write')
 * (payment/utils.py:273-282), then payment_transaction.py:373-400 action_capture on the (sudo) transactions; with no
 * transaction it returns :447-471 `_build_action_feedback_notification` of an empty recordset (success).
 */
registerMethod("account.move", "payment_action_capture", async (env, ids) => {
  const id = ensureOne(ids, "account.move");
  await env.model("account.move").checkAccess([id], "write");
  await fetchRecords(env, "account.move", [id], ["id"]);
  if (await transactionCount(env, [id])) throw new NotPorted("payment_action_capture with payment transactions");
  return {
    type: "ir.actions.client",
    tag: "display_notification",
    params: { type: "success", message: translate(env, "Your payment operation has been successfully submitted."), next: { type: "ir.actions.act_window_close" } },
  };
}, { apiModel: false });

/** account_payment/models/account_move.py:112-117 payment_action_void: returns None. */
registerMethod("account.move", "payment_action_void", async (env, ids) => {
  await env.model("account.move").checkAccess(ids ?? [], "write");
  await fetchRecords(env, "account.move", ids ?? [], ["id"]);
  if (await transactionCount(env, ids ?? [])) throw new NotPorted("payment_action_void with payment transactions");
  return null;
}, { apiModel: false });

/**
 * account_move.py:6821-6845 action_post (sale/models/account_move.py:113-131, account_peppol :165-168 and
 * stock_account :36-47 call super first) -> :6134-6236 `_post(soft=False)`. Ported up to the validation messages:
 * the group check (:6148-6149), and, when the only message is "must be in draft" (:6215-6216), the UserError. Any
 * other message, or a move that would really be posted, is NotPorted.
 */
registerMethod("account.move", "action_post", async (env, ids) => {
  const moveIds = ids ?? [];
  // :6824 `not context.get('disable_abnormal_invoice_detection', True)`
  if (env.context["disable_abnormal_invoice_detection"] === false) {
    const def = env.reg.model("account.move");
    for (const id of moveIds) {
      const m = new DbRec(env, def, id);
      if ((await m.get("abnormal_amount_warning")) || (await m.get("abnormal_date_warning"))) throw new NotPorted("action_post with the abnormal invoice detection (validate.account.move)");
    }
  }
  if (!moveIds.length) throw new NotPorted("action_post on an empty recordset (_show_autopost_bills_wizard)");
  // action_post is `_post(soft=False)` (:6838)
  await postMoves(env, moveIds, false);
  // sale account_move.py:113-131: the down payment lines of the posted invoices
  const { downPaymentAfterState } = await import("./sale_down_payment");
  await downPaymentAfterState(env, moveIds, "post");
  return false;
}, { apiModel: false });

/**
 * `move._post(soft=True)` called by compiled code (stock_landed_costs' button_validate): the method table entry is
 * reached only from compiled code, since call_kw refuses private names (src/http/methods.ts). It returns the posted
 * moves (`to_post`): the given ones, since the moves soft posting would leave out refuse (postMovesHand).
 */
registerMethod("account.move", "_post", async (env, ids, args, kwargs) => {
  const soft = args.length ? args[0] : "soft" in kwargs ? kwargs["soft"] : true;
  for (const k of Object.keys(kwargs)) if (k !== "soft" && k !== "context") throw new NotPorted(`account.move._post(${k}=)`);
  return postMoves(env, ids ?? [], Boolean(soft));
}, { apiModel: false });

/**
 * account_move.py:6134-6393 `_post(soft)`: validation messages, soft future-date auto_post scheduling,
 * and posting of drafts (account_move_ops.ts postDrafts). Returns the posted move IDs (`to_post`).
 */
export async function postMoves(env: Environment, moveIds: readonly number[], soft: boolean): Promise<number[]> {
  // a module's compiled override of `_post` runs first, with this as its super() (src/orm/private_hooks.ts)
  const res = await priv.account_move._post.call(env, moveIds, [soft], (e, ids, args) => postMovesHand(e, ids, args.length ? Boolean(args[0]) : soft));
  return Array.isArray(res) ? (res as number[]) : [...moveIds];
}

async function postMovesHand(env: Environment, moveIds: readonly number[], soft: boolean): Promise<number[]> {
  if (!env.su && !(await userHasGroup(env, "account.group_account_invoice"))) {
    throw new AccessError(translate(env, "You don't have the access rights to post an invoice."));
  }
  const postEnv = env.withContext({ ...env.context, skip_is_manually_modified: true });
  const moves = await fetchRecords(postEnv, "account.move", moveIds, ["name", "state", "move_type"]);
  const rows = (await postEnv.cr.query<Record<string, unknown>>(
    `SELECT m.id, m.quick_edit_total_amount, m.partner_bank_id, b.active AS bank_active, b.allow_out_payment,
            m.amount_total::float8 AS amount_total, cur.rounding::float8 AS currency_rounding, m.partner_id, m.invoice_date, m.auto_post, j.active AS journal_active,
            m.date::text AS date, m.currency_id = co.currency_id AS company_currency, m.currency_id, co.currency_id AS company_currency_id, m.company_id,
            m.invoice_currency_rate::float8 AS invoice_currency_rate
       FROM account_move m JOIN account_journal j ON j.id = m.journal_id JOIN res_company co ON co.id = m.company_id
       JOIN res_currency cur ON cur.id = m.currency_id
       LEFT JOIN res_partner_bank b ON b.id = m.partner_bank_id
      WHERE m.id = ANY($1::int[])`, [moveIds])).rows;
  const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
  const today = await contextToday(postEnv);
  const messages: string[] = [];
  const drafts: number[] = [];
  for (const move of moves) {
    const r = byId.get(Number(move["id"]))!;
    const type = String(move["move_type"]);
    if ([...INVOICE_TYPES, ...RECEIPT_TYPES].includes(type)) {
      // :6156-6211: quick edit total, archived or untrusted bank account, negative total, partner, invoice date
      if (r["quick_edit_total_amount"] !== null && Number(r["quick_edit_total_amount"]) !== 0) throw new NotPorted("_post: quick edit total check");
      // :6163-6182: an archived account refuses; the trust check only concerns inbound documents
      if (r["partner_bank_id"] !== null) {
        if (!r["bank_active"]) {
          throw new UserError(translate(
            postEnv,
            "The recipient bank account linked to this invoice is archived.\nSo you cannot confirm the invoice.",
            "account",
          ));
        }
        if (["out_invoice", "in_refund", "out_receipt"].includes(type) && !r["allow_out_payment"]) {
          throw new UserError(translate(
            postEnv,
            "The recipient bank account linked to this invoice is not trusted.\nSo you cannot confirm the invoice.",
            "account",
          ));
        }
      }
      if (Number(r["amount_total"]) < -(Number(r["currency_rounding"] ?? 0.01) / 2)) {
        messages.push(translate(
          postEnv,
          "You cannot validate an invoice with a negative total amount. You should create a credit note instead. Use the action menu to transform it into a credit note or refund.",
          "account",
        ));
      }
      // :6196-6203 a sale or purchase document (receipts excluded) without its partner
      if (r["partner_id"] === null) {
        if (["out_invoice", "out_refund"].includes(type)) {
          messages.push(translate(postEnv, "The 'Customer' field is required to validate the invoice.\nYou probably don't want to explain to your auditor that you invoiced an invisible man :)"));
        } else if (["in_invoice", "in_refund"].includes(type)) {
          messages.push(translate(postEnv, "The field 'Vendor' is required, please complete it to validate the Vendor Bill."));
        }
      }
      if (r["invoice_date"] === null) {
        // :6207-6212: a sale document gets today's date (with skip_is_manually_modified, :6152); purchases refuse
        if (!["out_invoice", "out_refund", "out_receipt"].includes(type)) throw new NotPorted("_post: purchase document without a date");
        // the date write runs _sync_dynamic_lines (:4083); if the accounting date was an earlier day, it moves to today
        // alongside invoice_date (account_move.py:1148-1155 `_compute_date`), and payment terms re-date accordingly.
        let rateChanged = false;
        let expectedRate = Number(r["invoice_currency_rate"]);
        if (!r["company_currency"]) {
          if (await priv.account_move._get_invoice_currency_rate_date.overridden(postEnv)) throw new NotPorted("_post: invoice date set at posting in a foreign currency with a module's _get_invoice_currency_rate_date");
          const { conversionRate } = await import("./currency_convert");
          expectedRate = await conversionRate(postEnv, Number(r["company_currency_id"]), Number(r["currency_id"]), Number(r["company_id"]), today);
          rateChanged = expectedRate !== Number(r["invoice_currency_rate"]);
        }
        // the recompute leaves an unchanged rate as stored; a new one is written as psycopg2 sends a Python float
        // (repr: `1.0`, not `1`, which the numeric column keeps as written)
        const rateParam = rateChanged ? pyFloatRepr(expectedRate) : null;
        if (r["date"] !== today) {
          await postEnv.cr.query(
            "UPDATE account_move SET invoice_date = $2, date = $2, invoice_currency_rate = COALESCE($4::numeric, invoice_currency_rate), write_uid = $3, write_date = (now() at time zone 'UTC') WHERE id = $1",
            [move["id"], today, postEnv.uid, rateParam],
          );
          await postEnv.cr.query(
            "UPDATE account_move_line SET invoice_date = $2, date = $2, write_uid = $3, write_date = (now() at time zone 'UTC') WHERE move_id = $1",
            [move["id"], today, postEnv.uid],
          );
          r["date"] = today;
        } else {
          await postEnv.cr.query(
            "UPDATE account_move SET invoice_date = $2, invoice_currency_rate = COALESCE($4::numeric, invoice_currency_rate), write_uid = $3, write_date = (now() at time zone 'UTC') WHERE id = $1",
            [move["id"], today, postEnv.uid, rateParam],
          );
          await postEnv.cr.query(
            "UPDATE account_move_line SET invoice_date = $2, write_uid = $3, write_date = (now() at time zone 'UTC') WHERE move_id = $1",
            [move["id"], today, postEnv.uid],
          );
        }
        if (rateChanged) {
          const { syncInvoice } = await import("./account_move_create");
          await syncInvoice(postEnv, Number(move["id"]), { resync: true, removed: new Set() });
        } else {
          await redateTerms(postEnv, Number(move["id"]));
        }
      }
    }
    // :6213-6247 per move
    const lines = (await postEnv.cr.query<Record<string, unknown>>(
      `SELECT l.display_type, l.is_imported, l.currency_id, l.company_currency_id, a.active, a.currency_id AS account_currency,
              EXISTS (SELECT 1 FROM account_account_res_company_rel rel JOIN res_company c ON c.id = rel.res_company_id
                       WHERE rel.account_account_id = a.id
                         AND (SELECT parent_path FROM res_company WHERE id = m.company_id) LIKE c.parent_path || '%') AS company_ok
         FROM account_move_line l JOIN account_account a ON a.id = l.account_id JOIN account_move m ON m.id = l.move_id
        WHERE l.move_id = $1`, [move["id"]])).rows;
    for (const l of lines) {
      // account_move_line.py:1832-1848 _check_constrains_account_id_journal_id
      if (["line_section", "line_subsection", "line_note"].includes(String(l["display_type"]))) continue;
      if (!l["active"] && !l["is_imported"]) throw new NotPorted("_post: archived account");
      if (l["account_currency"] !== null && l["account_currency"] !== l["company_currency_id"] && l["account_currency"] !== l["currency_id"]) {
        throw new NotPorted("_post: account forcing a secondary currency");
      }
    }
    if (["posted", "cancel"].includes(String(move["state"]))) {
      messages.push(translate(postEnv, "The entry %(name)s (id %(id)s) must be in draft.").replace("%(name)s", String(move["name"])).replace("%(id)s", String(move["id"])));
    } else drafts.push(Number(move["id"]));
    if (!lines.some((l) => !["line_section", "line_subsection", "line_note"].includes(String(l["display_type"])))) throw new NotPorted("_post: no lines");
    // :6221-6223 the future auto-post check is the soft=False one; soft=True leaves future moves for their date (:6256-6263)
    if (!soft && r["auto_post"] !== "no" && String(r["date"]) > today) {
      const dateMsg = await formatDate(postEnv, String(r["date"]));
      messages.push(translate(postEnv, "This move is configured to be auto-posted on %(date)s", "account").replace("%(date)s", dateMsg));
    }
    if (!r["journal_active"]) throw new NotPorted("_post: archived journal");
    // display_inactive_currency_warning is only true on draft moves (account_move.py:2028-2030)
    if (lines.some((l) => !l["active"])) throw new NotPorted("_post: archived account message");
    if (lines.some((l) => !l["company_ok"])) throw new NotPorted("_post: accounts of another company");
  }
  // :6249-6251 "\n".join(validation_msgs): a Python set, so only a single message has a known order
  const unique = [...new Set(messages)];
  if (unique.length) {
    if (unique.length !== 1) throw new NotPorted("_post: several validation messages (set order)");
    throw new UserError(unique[0]!);
  }
  // :6256-6265 soft=True schedules future-dated moves as auto_post='at_date' with a note
  let toPost = drafts;
  if (soft) {
    const future: number[] = [];
    toPost = [];
    for (const id of drafts) {
      const r = byId.get(id)!;
      if (String(r["date"]) > today) future.push(id);
      else toPost.push(id);
    }
    if (future.length) {
      const { postNote } = await import("./stock_engine");
      for (const id of future) {
        const r = byId.get(id)!;
        if (r["auto_post"] === "no") {
          await write(postEnv, "account.move", [id], { auto_post: "at_date" });
        }
        const dateStr = await formatDate(postEnv, String(r["date"]));
        const msg = translate(postEnv, "This move will be posted at the accounting date: %(date)s", "account").replace("%(date)s", dateStr);
        await postNote(postEnv, "account.move", id, `<p>${escapeText(msg)}</p>`);
      }
    }
  }
  // :6277-6278 recurring entries copy themselves
  if (!postEnv.context["skip_recurring_copy"]) {
    for (const id of toPost) {
      const r = byId.get(id)!;
      if (!["no", "at_date"].includes(String(r["auto_post"]))) {
        throw new NotPorted("_post: recurring entries (_copy_recurring_entries)");
      }
    }
  }
  if (toPost.length) await postDrafts(postEnv, toPost);
  return toPost;
}

// ---------------------------------------------------------------------------------------------------------------
// account.payment

/** account_payment/models/account_payment.py:148-156 action_refund_wizard. */
registerMethod("account.payment", "action_refund_wizard", async (env, ids) => {
  ensureOne(ids, "account.payment");
  return { name: translate(env, "Refund"), type: "ir.actions.act_window", view_mode: "form", res_model: "payment.refund.wizard", target: "new" };
}, { apiModel: false });

/** account_payment.py:1139-1143 `_get_trigger_fields_to_synchronize`. */
const SYNC_TO_MOVES = ["date", "amount", "payment_type", "partner_type", "payment_reference", "currency_id", "partner_id", "destination_account_id", "partner_bank_id", "journal_id"];

/**
 * account_payment.py:1023-1032 write: a state 'paid'/'reconciled' write generates and posts the journal entry, and a
 * payment with a move synchronizes it afterwards (:1071-1077, only for the trigger fields); neither is ported.
 */
async function paymentWrite(env: Environment, ids: readonly number[], vals: Record<string, unknown>): Promise<void> {
  if (["paid", "reconciled"].includes(String(vals["state"])) && !vals["move_id"]) throw new NotPorted("account.payment write of a paid state (_generate_journal_entry)");
  await write(env, "account.payment", ids, vals);
  if (ids.length && Object.keys(vals).some((k) => SYNC_TO_MOVES.includes(k))) {
    const r = await env.cr.query("SELECT 1 FROM account_payment WHERE id = ANY($1::int[]) AND move_id IS NOT NULL", [ids]);
    if (r.rows.length) throw new NotPorted("account.payment write with a journal entry (_synchronize_to_moves)");
  }
}

/** `self.move_id` of payments (the payments' order, each move once). */
async function paymentMoves(env: Environment, ids: readonly number[]): Promise<{ id: number; state: string }[]> {
  const rows = (await env.cr.query<{ id: number; state: string }>(
    `SELECT m.id, m.state FROM account_payment p JOIN account_move m ON m.id = p.move_id WHERE p.id = ANY($1::int[]) ORDER BY array_position($1::int[], p.id)`, [[...ids]])).rows;
  return rows.filter((r, i) => rows.findIndex((x) => x.id === r.id) === i);
}

/** account_payment.py:1196-1200 mark_as_sent / unmark_as_sent. */
registerMethod("account.payment", "mark_as_sent", async (env, ids) => { await paymentWrite(env, ids ?? [], { is_sent: true }); return null; }, { apiModel: false });
registerMethod("account.payment", "unmark_as_sent", async (env, ids) => { await paymentWrite(env, ids ?? [], { is_sent: false }); return null; }, { apiModel: false });

/** account_payment.py:1229-1230 action_reject: `self.state = 'rejected'` (fields.py:1992-2027 __set__ -> write). */
registerMethod("account.payment", "action_reject", async (env, ids) => { await paymentWrite(env, ids ?? [], { state: "rejected" }); return null; }, { apiModel: false });

/**
 * account_payment.py:1232-1236 action_cancel: the state write, then the draft moves unlinked (account_move.py:4200,
 * src/models/account_integrity.ts) and the others cancelled (a posted payment's move: `button_cancel` of a payment's
 * move refuses). The payments' state is tracked at precommit, after the unlink's "Journal Item deleted" logs.
 */
registerMethod("account.payment", "action_cancel", async (env, ids0) => {
  const ids = ids0 ?? [];
  const { trackPrepare } = await import("../mail/tracking");
  const { closeTrackingScope } = await import("../mail/write_hooks");
  await trackPrepare(env, "account.payment", ids);
  await paymentWrite(env, ids, { state: "canceled" });
  const moves = await paymentMoves(env, ids);
  const drafts = moves.filter((m) => m.state === "draft").map((m) => m.id);
  if (moves.length > drafts.length) throw new NotPorted("action_cancel of a payment whose journal entry is not a draft (button_cancel of a payment's move)");
  const { UNLINK_TRACKING, flushUnlinkTracking } = await import("./account_integrity");
  const defer = { states: new Map<number, [string, string]>(), later: [] as (() => Promise<void>)[], payments: [] as (() => Promise<void>)[] };
  if (drafts.length) {
    const { unlink } = await import("../orm/unlink");
    UNLINK_TRACKING.set(env.cr, defer);
    try {
      await unlink(env, "account.move", drafts);
    } finally {
      UNLINK_TRACKING.delete(env.cr);
    }
  }
  // at precommit: the payments' state (prepared first), then what the unlink's unreconciliation changed
  await closeTrackingScope(env, "account.payment");
  await flushUnlinkTracking(env, defer);
  return null;
}, { apiModel: false });

/** account_payment.py:1245-1247 action_draft: the state write, then `move_id.button_draft()` (account_move.py:6920). */
registerMethod("account.payment", "action_draft", async (env, ids0) => {
  const ids = ids0 ?? [];
  await paymentWrite(env, ids, { state: "draft" });
  const moves = await paymentMoves(env, ids);
  if (moves.length) await buttonDraft(env, moves.map((m) => m.id), true);
  return null;
}, { apiModel: false });

/** account_payment.py:1242-1243 button_request_cancel -> account_move.py:7064-7068 on `self.move_id`. */
registerMethod("account.payment", "button_request_cancel", async (env, ids) => {
  const rows = await fetchRecords(env, "account.payment", ids ?? [], ["move_id"]);
  const moves = [...new Set(rows.map((r) => m2oId(r["move_id"])).filter((x): x is number => x !== null))];
  // ensure_one on the moves: ValueError("Expected singleton") for none or several
  if (moves.length !== 1) throw new NotPorted("button_request_cancel: ensure_one on the payments' moves");
  const [move] = await fetchRecords(env, "account.move", moves, ["need_cancel_request"]);
  if (!move!["need_cancel_request"]) throw new UserError(translate(env, "You can only request a cancellation for invoice sent to the government."));
  throw new NotPorted("button_request_cancel of a move needing a cancel request (localization hook)");
}, { apiModel: false });

/**
 * account_payment/models/account_payment.py:132-146 action_post -> account_payment.py:1202-1227: the trusted
 * recipient bank account check reads `require_partner_bank_account` per payment, then the state write.
 */
registerMethod("account.payment", "action_post", async (env, ids) => {
  const rows = await fetchRecords(env, "account.payment", ids ?? [], ["require_partner_bank_account", "payment_type", "state"]);
  if (rows.length) throw new NotPorted("account.payment action_post of existing payments (journal entry generation)");
  return null;
}, { apiModel: false });

/**
 * account_peppol res_partner.py:42-47 `_onchange_verify_peppol_status` (on invoice_edi_format and routing_identifier,
 * so on every new partner form): the commercial partner is computed when empty (a new partner's is the partner itself,
 * res_partner.py `_compute_commercial_partner`), then `button_account_peppol_check_partner_endpoint` (:229-251) returns
 * at once without a routing identifier (account_edi_ubl_cii res_partner.py:156-163: "scheme:endpoint" when both are
 * set). With one, the verification on the form's record (with_company, `_origin`, the state of the new record) refuses.
 */
registerOnchange("res.partner", "_onchange_verify_peppol_status", ["invoice_edi_format", "routing_identifier"], async (_env, rec) => {
  if (!(await rec.get("commercial_partner_id")) && rec.origin !== null) throw new NotPorted("res.partner._onchange_verify_peppol_status without a commercial partner (_compute_commercial_partner)");
  if ((await rec.get("routing_scheme")) && (await rec.get("routing_endpoint"))) {
    throw new NotPorted("res.partner._onchange_verify_peppol_status with a routing identifier (Peppol verification on the form)");
  }
});

/** account_edi_ubl_cii res_partner.py:261-321 `_get_peppol_formats` (no installed localization adds one). */
const PEPPOL_FORMATS = ["ubl_bis3", "xrechnung", "nlcius"];

/**
 * account_peppol res_partner.py:229-251 `button_account_peppol_check_partner_endpoint(company)`. The verification
 * state comes from `_get_peppol_verification_state` (:262-280): in demo mode (res_company.py:283-289) the mock of
 * tools/demo_utils.py:94-103; otherwise the participant lookup through Odoo's Peppol proxy, which the measured
 * environment cannot reach (the oracle runs behind a dead HTTP proxy, run/odoo5.sh), so it returns None ('not_valid').
 * A changed state is written for the company and logged with `_log_verification_state_update` (:253-258, the
 * company-dependent tracking line of mail.mail_tracking_template).
 */
export async function checkPeppolPartnerEndpoint(env0: Environment, partner: number, company: number): Promise<void> {
  const env = env0.withContext({ ...env0.context, allowed_company_ids: [company] });
  const p = (await env.model("res.partner").read([partner], ["routing_scheme", "routing_endpoint", "invoice_edi_format", "peppol_verification_state"], ""))[0];
  if (!p || !p["routing_scheme"] || !p["routing_endpoint"]) return;
  // the three are inlined below, hooks: a module's override (l10n_fr_pdp: the PDP annuaire, its own log) refuses
  for (const h of [priv.res_partner._get_peppol_verification_state, priv.res_partner._log_verification_state_update, priv.res_partner._get_suggested_peppol_edi_format]) {
    if (await h.overridden(env)) throw new NotPorted(`the Peppol endpoint check with a module's ${h.name}`);
  }
  const proxies = (await env.cr.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM account_edi_proxy_client_user WHERE company_id = $1 AND proxy_type = 'peppol'", [company])).rows[0]?.n ?? "0";
  if (Number(proxies) > 0) throw new NotPorted("peppol edi mode of a company with a proxy user");
  const companyScheme = (await env.cr.query<{ s: string | null }>(
    "SELECT p.routing_scheme AS s FROM res_company co JOIN res_partner p ON p.id = co.partner_id WHERE co.id = $1", [company])).rows[0]?.s ?? null;
  const param = (await env.cr.query<{ value: string | null }>("SELECT value FROM ir_config_parameter WHERE key = 'account_peppol.edi.mode'")).rows[0]?.value ?? null;
  const mode = companyScheme === "odemo" ? "demo" : param || "prod";
  // account_edi_ubl_cii res_partner.py:309-316 `_get_peppol_edi_format`: without its own format the partner gets the
  // suggested one, which is always a Peppol format (a non-Peppol suggestion falls back to ubl_bis3)
  const own = typeof p["invoice_edi_format"] === "string" ? p["invoice_edi_format"] : "ubl_bis3";
  let state: string;
  // demo_utils.py:94-103: the routing identifier "scheme:endpoint" always has a colon here
  if (mode === "demo") state = !PEPPOL_FORMATS.includes(own) ? "not_valid_format" : "valid";
  else state = !PEPPOL_FORMATS.includes(own) ? "not_verified" : "not_valid";
  const old = String(p["peppol_verification_state"] || "not_verified");
  if (old === state) return;
  await write(env, "res.partner", [partner], { peppol_verification_state: state });
  const info = await env.model("res.partner").fieldsGet(["peppol_verification_state"], ["selection", "string"]);
  const field = info["peppol_verification_state"] ?? {};
  const labels = new Map(((field["selection"] ?? []) as [string, string][]).map(([k, v]) => [k, v]));
  const companyName = (await env.cr.query<{ name: string }>("SELECT name FROM res_company WHERE id = $1", [company])).rows[0]!.name;
  const body = `<div>\n        <em>${escapeText(`${companyName}: `)}</em>${escapeText(labels.get(old) ?? old)} → <b>${escapeText(labels.get(state) ?? state)}</b> <i>(${escapeText(String(field["string"] ?? "Peppol status"))})</i>\n</div>`;
  await messageLogBatch(env, "res.partner", new Map([[partner, body]]), { messageType: "tracking" });
}
