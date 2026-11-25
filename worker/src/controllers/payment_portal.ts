/**
 * The online payment of an invoice from the customer portal (payment/controllers/portal.py, account_payment
 * controllers/payment.py): `/invoice/transaction/<id>` creates the transaction and answers its processing values.
 * The provider modules' flows (payment_demo's simulation) and the processing are in src/models/payment_flow.ts.
 */
import { MissingError, NotPorted, ValidationError } from "../errors";
import type { RequestContext } from "../http/context";
import { jsonRoute, route } from "../http/router";
import { odooHmac } from "../models/util";
import { PyRecords } from "../qweb/records";
import { busLastId } from "../bus/bus";
import { BUS_WORKER_VERSION } from "../session/info";
import { renderPage } from "./page";
import { create } from "../orm/create";
import type { Environment } from "../orm/types";
import { translate } from "../models/util";
import { documentCheckAccess } from "./portal_invoice";
import { logMessageOnLinkedDocuments, processingValues, recordPaymentData } from "../models/payment_flow";
import { isInstalled } from "../http/modules";
import { AccessError } from "../errors";

const TX = "payment.transaction";
/** payment_status.py:21 `MONITORED_TX_ID_KEY`. */
export const MONITORED_TX_ID_KEY = "__payment_monitored_tx_id__";

async function isPublic(env: Environment): Promise<boolean> {
  return env.uid === (await env.cr.query<{ res_id: number }>("SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'public_user'")).rows[0]?.res_id;
}

export function validatePaymentAmount(raw: unknown, fallback?: number): number {
  const val = raw === undefined || raw === null ? fallback : raw;
  const n = typeof val === "number" ? val : typeof val === "string" && val.trim() !== "" ? Number(val) : NaN;
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError("The amount must be strictly positive.");
  }
  return n;
}

export function sanitizeLandingRoute(raw: unknown): string {
  if (raw === undefined || raw === null || raw === "") return "/payment/status";
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\r\n\0]/.test(raw)) {
    throw new ValidationError("Invalid landing route.");
  }
  return raw;
}

/** portal.py:554-588 `_validate_transaction_kwargs`: the whitelisted keys (BadRequest otherwise). */
function validateTransactionKwargs(kwargs: Readonly<Record<string, unknown>>, extra: readonly string[]): void {
  const whitelist = new Set(["provider_id", "payment_method_id", "token_id", "amount", "flow", "tokenization_requested", "landing_route", "is_validation", "csrf_token", ...extra]);
  const rejected = Object.keys(kwargs).filter((k) => !whitelist.has(k));
  if (rejected.length) throw new NotPorted(`transaction route with the kwargs ${rejected.join(", ")} (BadRequest)`);
}

/**
 * payment_transaction.py `_compute_reference(code, prefix, separator='-', **kwargs)` with account_payment's
 * `_compute_reference_prefix` (the invoices' names, payment_transaction.py:56-77): the prefix, or the prefix with the
 * next sequence number when a transaction already has it.
 */
async function computeReference(env: Environment, prefix: unknown, invoiceIds: readonly number[], nameNextInstallment: unknown): Promise<string> {
  const su = env.sudo();
  if (prefix) throw new NotPorted("payment.transaction reference with a given prefix (NFKD)");
  let p = "";
  if (invoiceIds.length) {
    const rows = (await su.cr.query<{ id: number; name: string | null }>("SELECT id, name FROM account_move WHERE id = ANY($1::int[])", [[...invoiceIds]])).rows;
    if (rows.length === invoiceIds.length) {
      // `invoices.filtered(lambda inv: inv.name).mapped('name')` in the order of the ids
      p = invoiceIds.map((id) => rows.find((r) => r.id === id)!.name).filter((n): n is string => Boolean(n)).join("-");
      if (nameNextInstallment) p = String(nameNextInstallment);
    }
  }
  if (!p) throw new NotPorted("payment.transaction reference without invoices (singularize_reference_prefix, the time)");
  if (!(await su.cr.query("SELECT 1 FROM payment_transaction WHERE reference = $1 LIMIT 1", [p])).rows.length) return p;
  const same = (await su.cr.query<{ reference: string }>("SELECT reference FROM payment_transaction WHERE reference LIKE $1", [`${p.replace(/[\\%_]/g, (c) => `\\${c}`)}-%`])).rows;
  const re = new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-(\\d+)$`);
  let max = 0;
  for (const r of same) {
    const m = re.exec(r.reference);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${p}-${max + 1}`;
}

/** portal.py:337-435 `_create_transaction` for a direct or redirect flow without tokenization. */
async function createTransaction(ctx: RequestContext, env: Environment, kw: Record<string, unknown>, customCreateValues: Record<string, unknown>, invoiceIds: number[]): Promise<number> {
  const su = env.sudo();
  const flow = String(kw["flow"]);
  if (flow !== "direct" && flow !== "redirect") throw new NotPorted(`payment flow ${flow} (tokens)`);
  if (kw["is_validation"]) throw new NotPorted("payment validation transaction");
  const providerId = Number(kw["provider_id"]);
  const pmId = Number(kw["payment_method_id"]);
  const [prov] = await su.model("payment.provider").read([providerId], ["code", "allow_tokenization", "is_live"], "");
  if (!prov) throw new MissingError("Record does not exist or has been deleted.");
  const [pm] = await su.withContext({ ...su.context, active_test: false }).model("payment.method").read([pmId], ["support_tokenization"], "");
  // :384-390 the tokenization (provider's `_is_tokenization_required()` is payment's False here)
  if (prov["allow_tokenization"] && pm?.["support_tokenization"] && kw["tokenization_requested"]) throw new NotPorted("payment transaction with tokenization");
  const reference = await computeReference(env, kw["reference_prefix"], invoiceIds, kw["name_next_installment"]);
  // payment_transaction.py create: the partner's values duplicated (as superuser: the controller's sudo)
  const partnerId = Number(kw["partner_id"]);
  const [p] = await su.model("res.partner").read([partnerId], ["name", "parent_id", "lang", "email", "street", "street2", "zip", "city", "state_id", "country_id", "phone"], "");
  if (!p) throw new MissingError("Record does not exist or has been deleted.");
  const idOf = (v: unknown): number | false => (Array.isArray(v) && typeof v[0] === "number" ? v[0] : typeof v === "number" ? v : false);
  let partnerName = p["name"] || false;
  if (!partnerName && idOf(p["parent_id"])) partnerName = (await su.model("res.partner").read([idOf(p["parent_id"]) as number], ["name"], ""))[0]?.["name"] ?? false;
  const email = typeof p["email"] === "string" ? p["email"] : "";
  if (email && (/[,;]/.test(email) || /<|>/.test(email))) throw new NotPorted("payment.transaction partner_email of several or formatted emails (email_normalize_all)");
  const address = `${(p["street"] as string) || ""} ${(p["street2"] as string) || ""}`.trim();
  const [txId] = await create(su, TX, [{
    provider_id: providerId, payment_method_id: pmId, reference, amount: kw["amount"], currency_id: kw["currency_id"], partner_id: partnerId,
    token_id: false, operation: `online_${flow}`, tokenize: false, landing_route: kw["landing_route"], ...customCreateValues,
    is_live: Boolean(prov["is_live"]), partner_name: partnerName, partner_lang: p["lang"] || false, partner_email: email ? email.trim().toLowerCase() : false,
    partner_address: address, partner_zip: p["zip"] || false, partner_city: p["city"] || false, partner_state_id: idOf(p["state_id"]),
    partner_country_id: idOf(p["country_id"]), partner_phone: p["phone"] || false,
  }]);
  // :427-430 `_log_sent_message` of a direct or redirect payment
  const [tx] = await su.model(TX).read([txId!], ["operation", "amount", "currency_id", "reference"], "");
  if (tx?.["operation"] !== "validation") await logMessageOnLinkedDocuments(env, txId!, "sent");
  // :432-433 `PaymentStatus.monitor_transaction`
  ctx.session[MONITORED_TX_ID_KEY] = txId;
  return txId!;
}

// account_payment controllers/payment.py:12-33 `/invoice/transaction/<int:invoice_id>`, with :59-70 `_process_transaction`
jsonRoute("/invoice/transaction/<int:invoice_id>", async (ctx, params) => {
  const env = await ctx.orm();
  const invoiceId = Number(params["invoice_id"]);
  // the path argument is a parameter of its own, not one of the kwargs
  const { access_token: accessToken, invoice_id: _path, ...kwargs } = (ctx.jsonParams ?? {}) as Record<string, unknown>;
  let invoice;
  try {
    invoice = await documentCheckAccess(env, "account.move", invoiceId, typeof accessToken === "string" ? accessToken : null);
  } catch (e) {
    if (e instanceof AccessError) throw new ValidationError(translate(env, "The access token is invalid.", "account_payment"));
    throw e;
  }
  const loggedIn = !(await isPublic(env));
  const partnerId = loggedIn
    ? (await env.sudo().cr.query<{ partner_id: number }>("SELECT partner_id FROM res_users WHERE id = $1", [env.uid])).rows[0]!.partner_id
    : ((await invoice.field("partner_id")) as { ids: number[] }).ids[0]!;
  validateTransactionKwargs(kwargs, ["name_next_installment"]);
  let fallbackAmount: number | undefined;
  if (kwargs["amount"] === undefined || kwargs["amount"] === null) {
    const residualRaw = await invoice.field("amount_residual");
    fallbackAmount = typeof residualRaw === "number" ? residualRaw
      : typeof residualRaw === "object" && residualRaw !== null && "float" in residualRaw ? Number((residualRaw as { float: number }).float)
      : Number(residualRaw ?? NaN);
  }
  const amount = validatePaymentAmount(kwargs["amount"], fallbackAmount);
  const landingRoute = sanitizeLandingRoute(kwargs["landing_route"]);
  const currency = ((await invoice.field("currency_id")) as { ids: number[] }).ids[0]!;
  const kw = { ...kwargs, amount, landing_route: landingRoute, currency_id: currency, partner_id: partnerId, reference_prefix: false };
  const txId = await createTransaction(ctx, env, kw, { invoice_ids: [[6, 0, [invoiceId]]] }, [invoiceId]);
  return processingValues(env, txId);
}, { auth: "public" });

// payment_demo controllers/main.py:9-17 `/payment/demo/simulate_payment`: the transaction of the reference
// (payment_transaction.py:888-912 `_search_by_reference` with `_extract_reference`, as superuser), its payment data
// recorded (:922-940 `_record`: a payment.data and the processing cron triggered)
jsonRoute("/payment/demo/simulate_payment", async (ctx) => {
  const env = await ctx.orm();
  if (!(await isInstalled(env.cr, "payment_demo"))) throw new NotPorted("/payment/demo/simulate_payment without payment_demo (404)");
  const data = (ctx.jsonParams ?? {}) as Record<string, unknown>;
  const su = env.sudo();
  const reference = data["reference"];
  if (!reference) return null; // a warning logged, no transaction
  const txs = (await su.cr.query<{ id: number }>(
    "SELECT t.id FROM payment_transaction t JOIN payment_provider p ON p.id = t.provider_id WHERE t.reference = $1 AND p.code = 'demo' ORDER BY t.id DESC", [reference])).rows.map((r) => r.id);
  if (!txs.length) return null;
  if (txs.length > 1) throw new NotPorted("several transactions of one reference (ensure_one)");
  await recordPaymentData(su, txs[0]!, data);
  return null;
}, { auth: "public" });

// payment_custom controllers/main.py:12-26 `/payment/custom/process` (the action of the redirect form its
// `_get_specific_rendering_values` gives: CustomController._process_url): the custom transaction of the reference
// (`_search_by_reference('custom', ...)`, as superuser) has its payment data recorded (`_record`), then
// `request.redirect('/payment/status')`
route("/payment/custom/process", async (ctx) => {
  const env = await ctx.orm();
  if (!(await isInstalled(env.cr, "payment_custom"))) throw new NotPorted("/payment/custom/process without payment_custom (404)");
  const params = ctx.params;
  for (const k of Object.keys(params)) if (k !== "reference") throw new NotPorted(`/payment/custom/process with the parameter ${k}`);
  const reference = params["reference"];
  const su = env.sudo();
  if (typeof reference === "string" && reference) {
    const txs = (await su.cr.query<{ id: number }>(
      "SELECT t.id FROM payment_transaction t JOIN payment_provider p ON p.id = t.provider_id WHERE t.reference = $1 AND p.code = 'custom' ORDER BY t.id DESC", [reference])).rows.map((r) => r.id);
    if (txs.length > 1) throw new NotPorted("several transactions of one reference (ensure_one)");
    if (txs.length) await recordPaymentData(su, txs[0]!, { reference });
  }
  return ctx.redirect("/payment/status");
}, { auth: "public", methods: ["POST"], csrf: false });

/** payment_status.py:94-106 `_get_monitored_transaction`: the session's transaction, if it exists (as superuser). */
async function monitoredTransaction(ctx: RequestContext, env: Environment): Promise<number | null> {
  const id = ctx.session[MONITORED_TX_ID_KEY];
  if (typeof id !== "number") return null;
  return (await env.sudo().cr.query("SELECT 1 FROM payment_transaction WHERE id = $1", [id])).rows.length ? id : null;
}

// payment_status.py:24-66 `/payment/status`: the monitored transaction's status page (payment.payment_status), with
// the channel its status is notified on and the bus information of the session
route("/payment/status", async (ctx) => {
  const env = await ctx.orm();
  const txId = await monitoredTransaction(ctx, env);
  let values: Record<string, unknown>;
  if (txId === null) values = { payment_not_found: true };
  else {
    // payment/utils.py:23-39 `generate_access_token(tx.id)`: hmac(env(su=True), 'generate_access_token', 'id')
    const token = await odooHmac(env.sudo(), "generate_access_token", String(txId));
    values = {
      tx: new PyRecords(env.sudo(), TX, [txId]), notification_channel: `payment_transaction_channel:${txId},${token}`,
      extra_session_info: new Map([["bus_info", new Map<string, unknown>([["last_id", await busLastId(env.cr)], ["worker_version", BUS_WORKER_VERSION]])]]),
    };
  }
  const html = await renderPage(ctx, "payment.payment_status", values, env);
  return new Response(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}, { auth: "public" });

// payment_status.py:71-80 `/payment/process`: the processing cron run at once when the monitored transaction has
// payment data (payment_transaction.py:944-959 `_run_processing`: the cron locked, else nothing to do, then
// `method_direct_trigger` as superuser)
jsonRoute("/payment/process", async (ctx) => {
  const env = await ctx.orm();
  const txId = await monitoredTransaction(ctx, env);
  if (txId === null) return null;
  if (!(await env.sudo().cr.query("SELECT 1 FROM payment_data WHERE transaction_id = $1 LIMIT 1", [txId])).rows.length) return null;
  const cron = await env.reg.xmlid(env.cr, "payment.processing_cron");
  if (typeof cron !== "number") throw new NotPorted("payment.processing_cron missing");
  // `lock_for_update(allow_referencing=True)`: FOR NO KEY UPDATE NOWAIT; a LockError means the cron runs already
  try {
    await env.cr.query("SAVEPOINT payment_process_lock");
    await env.cr.query("SELECT id FROM ir_cron WHERE id = $1 FOR NO KEY UPDATE NOWAIT", [cron]);
    await env.cr.query("RELEASE SAVEPOINT payment_process_lock");
  } catch (e) {
    await env.cr.query("ROLLBACK TO SAVEPOINT payment_process_lock");
    if ((e as { code?: string }).code === "55P03") return null;
    throw e;
  }
  const { lookupMethod } = await import("../http/methods");
  await lookupMethod("ir.cron", "method_direct_trigger")!.fn(env.sudo(), [cron], [], {}, "ir.cron");
  return null;
}, { auth: "public" });
