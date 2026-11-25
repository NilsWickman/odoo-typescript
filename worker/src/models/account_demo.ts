/**
 * `account.chart.template._install_demo` (account/models/chart_template.py:263-275) with account's demo data
 * (account/demo/account_demo.py), the only `@template(demo=True)` functions of the poc_erp templates' generic code
 * (`_template_register[True][None]`; l10n_us_account's and l10n_be's are for their own codes). The data is built
 * here as Odoo's functions build it, in the order `_get_chart_template_data(demo=True)` gives (the template models
 * first, then the others in registration order, account.move last), loaded through the chart loader
 * (src/models/chart_template.ts `loadData`), then `_post_load_demo_data` posts the moves.
 */
import { NotPorted, UserError, ValidationError } from "../errors";
import { lookupMethod } from "../http/methods";
import { and, cond } from "../orm/domain";
import type { Environment } from "../orm/types";
import { dbNow, todayInTz } from "./util";
import { companyXmlid, loadData, type Data, type Key, type Loader, type Vals } from "./chart_template";
import { genAssetJson } from "../gen_assets";
import { DbRec } from "../orm/recompute";
import { overridesOf } from "../orm/write";
import * as priv from "../orm/dispatch_gen";

const create = (vals: Vals): unknown[] => [0, 0, vals];

/** `date` + days, as `YYYY-MM-DD` (Python `date + timedelta(days=n)`). */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** `date + relativedelta(months=n)`: the day clamped to the target month's length. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const ty = Math.floor(total / 12), tm = total % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  return `${String(ty).padStart(4, "0")}-${String(tm + 1).padStart(2, "0")}-${String(Math.min(d, last)).padStart(2, "0")}`;
}

async function one<T>(env: Environment, sql: string, params: unknown[]): Promise<T | undefined> {
  return (await env.cr.query<T & Record<string, unknown>>(sql, params)).rows[0];
}

/** `self.env['account.account'].with_company(company).search([*_check_company_domain(company), *domain], limit=1)`:
 * the ORM's search, so archived accounts are left out (active_test) and the order is `_order` (account_account.py:29
 * "code_path, account_type, name_path", the parents' codes first: a chart with group accounts such as l10n_zm's). */
async function firstAccount(env: Environment, company: number, domain: Parameters<typeof and>[0]): Promise<number | false> {
  const acc = env.withContext({ ...env.context, allowed_company_ids: [company] });
  const [id] = await acc.model("account.account").search(and([cond("company_ids", "in", [company]), ...domain]), { limit: 1, order: null });
  return id ?? false;
}

/** account_demo.py:565-585 `_get_demo_account`. */
async function demoAccount(env: Environment, xmlid: string, accountType: string, company: number): Promise<number | false> {
  const byXmlid = await one<{ res_id: number }>(env,
    "SELECT res_id FROM ir_model_data WHERE name = $1 AND model = 'account.account' ORDER BY module, name LIMIT 1", [`${company}_${xmlid}`]);
  if (byXmlid) return byXmlid.res_id;
  return await firstAccount(env, company, [cond("account_type", "=", accountType)]) || await firstAccount(env, company, []);
}

/** The demo data of the company (`_get_chart_template_data(template_code, demo=True)` for the generic functions). */
async function demoData(ld: Loader, company: number): Promise<Data> {
  const env = ld.env;
  const today = todayInTz(await dbNow(env), "UTC"); // fields.Date.today() and time.strftime in a UTC process
  const month1 = `${today.slice(0, 8)}01`;
  const oneMonthAgo = addMonths(today, -1);
  const data: Data = new Map();
  const put = (model: string, entries: [Key, Vals][]): void => {
    if (entries.length) data.set(model, new Map(entries));
  };
  data.set("res.company", new Map());

  // the template models first (TEMPLATE_MODELS order): account.journal (:119-129), account.reconcile.model (:413-458)
  const partner = (await one<{ p: number }>(env, "SELECT partner_id AS p FROM res_company WHERE id = $1", [company]))!.p;
  const bank = await one<{ id: number }>(env, "SELECT id FROM res_partner_bank WHERE partner_id = $1 ORDER BY sequence, id LIMIT 1", [partner]);
  put("account.journal", bank ? [["bank", { bank_account_id: bank.id }]] : []);
  put("account.reconcile.model", [
    ["reconcile_from_label", {
      name: "Line with Bank Fees", match_label: "contains", match_label_param: "BRT",
      line_ids: [
        create({ label: "Due amount", account_id: await demoAccount(env, "income", "income", company), amount_type: "regex", amount_string: String.raw`BRT: ([\d,.]+)` }),
        create({ label: "Bank Fees", account_id: await demoAccount(env, "expense_finance", "expense", company), amount_type: "percentage", amount_string: "100" }),
      ],
    }],
    ["owner_current_account_model", {
      name: "Owner's Current Account",
      line_ids: [create({ label: "Owner's Current Account", account_id: await demoAccount(env, "owner_current_account", "asset_receivable", company), amount_type: "percentage", amount_string: "100" })],
    }],
  ]);

  // the other models in registration order (the functions' names): ir.attachment, res.partner.bank, mail.activity,
  // mail.message, product.product, product.template, account.bank.statement, account.bank.statement.line
  const pdfs = await genAssetJson("poc_erp_se/account_demo_files.json") as Record<string, string>;
  const raw = (path: string): unknown => {
    const b64 = pdfs[path];
    if (b64 === undefined) throw new NotPorted(`account demo file ${path} is not packaged (gen/account_demo_files.py)`);
    return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); // `file_read`: the bytes, given as raw
  };
  put("ir.attachment", [
    ["ir_attachment_in_invoice_1", { type: "binary", name: "in_invoice_yourcompany_demo.pdf", res_model: "account.move", res_id: "demo_invoice_8", res_field: "invoice_pdf_report_file", raw: raw("account/static/demo/in_invoice_yourcompany_demo_1.pdf") }],
    ["ir_attachment_in_invoice_2", { type: "binary", name: "in_invoice_yourcompany_demo.pdf", res_model: "account.move", res_id: "demo_invoice_equipment_purchase", res_field: "invoice_pdf_report_file", raw: raw("account/static/demo/in_invoice_yourcompany_demo_2.pdf") }],
    ["ir_attachment_bank_statement_1", { type: "binary", name: "bank_statement_one_month_old.pdf", res_model: "account.bank.statement", res_id: "demo_bank_statement_1", raw: raw("account/static/demo/bank_statement_one_month_old.pdf") }],
  ]);
  // :105-117 a demo bank account only when the root company's partner has none
  const root = (await one<{ p: number }>(env, "SELECT c.partner_id AS p FROM res_company c WHERE c.id = $1", [ld.root]))!.p;
  if (!(await one(env, "SELECT 1 FROM res_partner_bank WHERE partner_id = $1 LIMIT 1", [root]))) {
    put("res.partner.bank", [["demo_bank_1", { account_number: `BANK${company}34567890`, partner_id: root, journal_id: "bank", allow_out_payment: true }]]);
  }
  const deadline = (days: number): string => `${addDays(today, days)} 00:00`; // fields.Datetime.today() + days, '%Y-%m-%d %H:%M'
  put("mail.activity", [
    ["invoice_activity_1", { res_id: "demo_invoice_3", res_model_id: "account.model_account_move", activity_type_id: "mail.mail_activity_data_todo", date_deadline: deadline(5), summary: "Follow-up on payment", create_uid: "base.user_admin", user_id: "base.user_admin" }],
    ["invoice_activity_2", { res_id: "demo_invoice_2", res_model_id: "account.model_account_move", activity_type_id: "mail.mail_activity_data_call", date_deadline: deadline(0), summary: "Follow up on missed call", create_uid: "base.user_admin", user_id: "base.user_admin" }],
    ["invoice_activity_3", { res_id: "demo_invoice_1", res_model_id: "account.model_account_move", activity_type_id: "mail.mail_activity_data_todo", date_deadline: deadline(5), summary: "Include upsell", create_uid: "base.user_admin", user_id: "base.user_admin" }],
    ["invoice_activity_4", { res_id: "demo_invoice_8", res_model_id: "account.model_account_move", activity_type_id: "mail.mail_activity_data_todo", date_deadline: deadline(5), summary: "Update address", create_uid: "base.user_admin", user_id: "base.user_admin" }],
  ]);
  put("mail.message", [
    ["mail_message_in_invoice_1", { model: "account.move", res_id: "demo_invoice_8", body: "Vendor Bill attachment", message_type: "comment", author_id: "base.partner_demo", attachment_ids: [[6, 0, ["ir_attachment_in_invoice_1"]]] }],
    ["mail_message_in_invoice_2", { model: "account.move", res_id: "demo_invoice_equipment_purchase", body: "Vendor Bill attachment", message_type: "comment", author_id: "base.partner_demo", attachment_ids: [[6, 0, ["ir_attachment_in_invoice_2"]]] }],
    ["mail_message_bank_statement_1", { model: "account.bank.statement", res_id: "demo_bank_statement_1", body: "Bank Statement attachment", message_type: "comment", author_id: "base.partner_demo", attachment_ids: [[6, 0, ["ir_attachment_bank_statement_1"]]] }],
  ]);
  // :33-73 the products' taxes only for base.main_company
  const main = await one<{ res_id: number }>(env, "SELECT res_id FROM ir_model_data WHERE module = 'base' AND name = 'main_company'", []);
  if (main?.res_id === company) throw new NotPorted("account demo data of base.main_company (the demo products' taxes)");
  // account.bank.statement.line `create` (account_bank_statement_line.py:363-421: its move, the default move lines,
  // the post) is not ported; the generic create would fail on the line's journal and Odoo's demo would differ
  if (!overridesOf("account.bank.statement.line").create) throw new NotPorted("account.bank.statement.line create (the demo statement and transactions)");
  // :335-373 the statement of the first bank journal (`_order` sequence, type, code)
  const bnk = (await one<{ id: number; name: string }>(env,
    "SELECT id, name->>'en_US' AS name FROM account_journal WHERE company_id = $1 AND type = 'bank' ORDER BY sequence, type, code, id LIMIT 1", [company]))!;
  if (!bnk) throw new NotPorted("account demo data without a bank journal");
  const year = today.slice(0, 4);
  put("account.bank.statement", [["demo_bank_statement_1", {
    name: `${bnk.name} - ${oneMonthAgo}`, balance_end_real: 6678.0, balance_start: 4253.0,
    attachment_ids: [[6, 0, ["ir_attachment_bank_statement_1"]]],
    line_ids: [
      create({ journal_id: bnk.id, payment_ref: "Office rent", amount: -850.0, date: oneMonthAgo }),
      create({ journal_id: bnk.id, payment_ref: `INV/${year}/00006 and INV/${year}/00007`, amount: 1275.0, date: oneMonthAgo, partner_name: "Open Wood Inc." }),
      create({ journal_id: bnk.id, payment_ref: "Payment of your invoice #5", amount: 2000.0, date: addDays(today, -40), partner_name: "Open Wood Inc." }),
    ],
  }]]);
  if (env.lang && env.lang !== "en_US") throw new NotPorted(`account demo data in ${env.lang} (formatLang)`);
  put("account.bank.statement.line", [
    ["demo_bank_statement_line_0", { journal_id: "bank", payment_ref: "BILL/2024/01/0001", amount: -622.27, partner_id: "base.res_partner_3" }],
    ["demo_bank_statement_line_1", { journal_id: "bank", payment_ref: "Office rent", amount: -850.0 }],
    ["demo_bank_statement_line_2", { journal_id: "bank", payment_ref: "Prepayment for invoice #9", amount: 650.0, partner_name: "Open Wood Inc." }],
    ["demo_bank_statement_line_3", { journal_id: "bank", payment_ref: "Last Year Interests", amount: 102.78 }],
    ["demo_bank_statement_line_4", { journal_id: "bank", payment_ref: `INV/${year}/00008`, amount: 738.75, partner_id: "base.res_partner_6" }],
    ["demo_bank_statement_line_5", { journal_id: "bank", payment_ref: "R:9772938  10/07 AX 9415116318 T:5 BRT: 100.00 C/ croip", amount: 96.67 }],
  ]);

  // account.move last (:131-333, chart_template.py:854-855)
  // `self.env.company.partner_id.property_account_receivable_id`: company dependent, read in the company's env
  const recv = await new DbRec(env, env.reg.model("res.partner"), partner).get("property_account_receivable_id");
  const receivable = { id: (Array.isArray(recv) ? recv[0] : recv) as number | false };
  const bankDefault = await one<{ id: number }>(env, "SELECT default_account_id AS id FROM account_journal WHERE id = $1", [await ld.ref("bank")]);
  const gain = await one<{ id: number | null }>(env, "SELECT account_journal_early_pay_discount_gain_account_id AS id FROM res_company WHERE id = $1", [company]);
  const incomeId = await firstAccount(env, company, [cond("account_type", "=", "income"), cond("id", "!=", gain?.id ?? false)]);
  const income = incomeId === false ? undefined : { id: incomeId };
  const line = (product: string, quantity: number, priceUnit?: number): unknown[] => create(priceUnit === undefined ? { product_id: product, quantity } : { product_id: product, price_unit: priceUnit, quantity });
  const inv = (moveType: string, partner: string, user: string | false | undefined, date: string, lines: unknown[][], extra: Vals = {}): Vals => ({
    move_type: moveType, partner_id: partner, ...(user === undefined ? {} : { invoice_user_id: user }), ...extra,
    invoice_date: date, delivery_date: date, invoice_line_ids: lines,
  });
  const eom = { invoice_payment_term_id: "account.account_payment_term_end_following_month" };
  const moves: [Key, Vals][] = [
    ["demo_invoice_1", inv("out_invoice", "base.res_partner_12", "base.user_admin", month1, [line("product.consu_delivery_02", 5), line("product.consu_delivery_03", 5)], eom)],
    ["demo_invoice_2", inv("out_invoice", "base.res_partner_2", false, addDays(today, -2), [line("product.consu_delivery_03", 5), line("product.consu_delivery_01", 20)])],
    ["demo_invoice_3", inv("out_invoice", "base.res_partner_2", "base.user_demo", addDays(today, -3), [line("product.consu_delivery_01", 5), line("product.consu_delivery_03", 5)])],
    ["demo_invoice_followup", inv("out_invoice", "base.res_partner_2", "base.user_admin", addDays(today, -15), [line("product.consu_delivery_02", 5), line("product.consu_delivery_03", 5)], { invoice_payment_term_id: "account.account_payment_term_immediate" })],
    ["demo_invoice_5", inv("out_invoice", "base.res_partner_5", "base.user_admin", addDays(today, -40), [line("product.product_order_01", 10, 200)], eom)],
    ["demo_invoice_6", inv("out_invoice", "base.res_partner_5", "base.user_admin", addDays(today, -35), [line("product.product_order_01", 10, 100.0)], eom)],
    ["demo_invoice_7", inv("out_invoice", "base.res_partner_5", "base.user_admin", addMonths(today, -1), [line("product.product_order_01", 1, 275)], eom)],
    ["demo_invoice_8", inv("in_invoice", "base.res_partner_4", undefined, month1, [line("product.product_order_01", 1, 10.0), line("product.product_delivery_01", 5, 4)], { ...eom, message_main_attachment_id: "ir_attachment_in_invoice_1" })],
    ["demo_invoice_equipment_purchase", inv("in_invoice", "base.res_partner_3", false, addDays(today, -20), [create({ name: "Redeem Reference Number: PO02529", quantity: 1, price_unit: 622.27 })],
      { ref: `INV/${addDays(today, -20).slice(0, 4)}/0057`, message_main_attachment_id: "ir_attachment_in_invoice_2" })],
    ["demo_invoice_9", inv("out_invoice", "base.res_partner_6", false, today, [line("product.product_delivery_02", 15, 50.00)])],
    ["demo_invoice_10", inv("out_invoice", "base.res_partner_5", false, addDays(today, -5), [line("product.consu_delivery_03", 1, 1799)])],
    ["demo_move_auto_reconcile_1", inv("out_refund", "base.res_partner_12", undefined, `${oneMonthAgo.slice(0, 8)}02`, [line("product.consu_delivery_03", 5)])],
    ["demo_move_auto_reconcile_2", inv("out_refund", "base.res_partner_12", undefined, `${oneMonthAgo.slice(0, 8)}03`, [line("product.consu_delivery_02", 5)])],
    ["demo_move_auto_reconcile_3", inv("in_refund", "base.res_partner_4", undefined, month1, [line("product.product_delivery_01", 1, 10.0), line("product.product_order_01", 5, 4.0)], { message_main_attachment_id: "ir_attachment_in_invoice_1" })],
    ["demo_move_auto_reconcile_4", inv("out_refund", "base.res_partner_2", undefined, addDays(today, -10), [line("product.consu_delivery_02", 5), line("product.consu_delivery_03", 5)])],
    ["demo_move_auto_reconcile_5", inv("out_refund", "base.res_partner_2", undefined, addDays(today, -2), [line("product.consu_delivery_01", 5), line("product.consu_delivery_03", 5)])],
    ["demo_move_auto_reconcile_6", { move_type: "entry", partner_id: "base.res_partner_2", date: addDays(today, -20), journal_id: "general",
      line_ids: [create({ debit: 0.0, credit: 2500.0, account_id: receivable?.id ?? false }), create({ debit: 2500.0, credit: 0.0, account_id: bankDefault?.id ?? false })] }],
    ["demo_move_auto_reconcile_7", { move_type: "entry", partner_id: "base.res_partner_2", date: addDays(today, -20), journal_id: "general",
      line_ids: [create({ debit: 2500.0, credit: 0.0, account_id: receivable?.id ?? false }), create({ debit: 0.0, credit: 2500.0, account_id: income?.id ?? false })] }],
  ];
  // the keys are `self.company_xmlid(...)` already (account.<company>_<name>)
  data.set("account.move", new Map(moves.map(([k, v]) => [companyXmlid(String(k), company), v])));
  return data;
}

const POSTED = ["demo_invoice_1", "demo_invoice_2", "demo_invoice_3", "demo_invoice_followup", "demo_invoice_5", "demo_invoice_6",
  "demo_invoice_7", "demo_invoice_8", "demo_invoice_equipment_purchase", "demo_invoice_9", "demo_invoice_10",
  "demo_move_auto_reconcile_1", "demo_move_auto_reconcile_2", "demo_move_auto_reconcile_3", "demo_move_auto_reconcile_4",
  "demo_move_auto_reconcile_5", "demo_move_auto_reconcile_6", "demo_move_auto_reconcile_7"];

/**
 * :274 `self_ctx._post_load_demo_data(company.chart_template)` through the private hook: a site's compiled override
 * (l10n_it: the demo partners' bank accounts and its own demo moves posted, for the it template) runs around the
 * hand port's, `postLoadDemoDataOf`. The override must pass on the load's template code.
 */
async function postLoadDemoData(env: Environment, pl: Loader, code: string): Promise<void> {
  await priv.account_chart_template._post_load_demo_data.call(env, [], [code], async (_e, _ids, args) => {
    if (args[0] !== code) {
      throw new NotPorted(`account.chart.template._post_load_demo_data called by an override with another template than the load's (${JSON.stringify(args[0])})`);
    }
    await postLoadDemoDataOf(env, pl);
    return null;
  });
}

/** Each move posted, a UserError or ValidationError only logged. */
async function postEach(env: Environment, ids: readonly number[]): Promise<void> {
  const post = lookupMethod("account.move", "action_post");
  if (!post) throw new NotPorted("account.move action_post");
  for (const id of ids) {
    try {
      await post.fn(env, [id], [], {}, "account.move");
    } catch (e) {
      if (e instanceof UserError || e instanceof ValidationError) continue;
      throw e;
    }
  }
}

/**
 * account/demo/account_demo.py:75-103 account's `_post_load_demo_data` (each demo move posted), with l10n_us_account's
 * (l10n_us_account/demo/account_demo.py:148-157, after super(): its two demo invoices posted where they exist) when it
 * is installed: both are the baseline's definitions.
 */
async function postLoadDemoDataOf(env: Environment, pl: Loader): Promise<void> {
  // account's: `self.ref(...) + ...`, every ref resolved (raising) before the first post
  const moves: number[] = [];
  for (const name of POSTED) moves.push((await pl.ref(name))!);
  await postEach(env, moves);
  if ((await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = 'l10n_us_account' AND state = 'installed'", [])).rows.length) {
    for (const name of ["demo_invoice_us_tax", "demo_invoice_us_tax_tx"]) {
      const id = await pl.ref(name, false);
      if (id !== null) await postEach(env, [id]);
    }
  }
}

/** chart_template.py:263-275 `_install_demo` for one company, with the `ld` of its chart load and its template code. */
export async function installDemo(ld: Loader, company: number, code: string, makeLoader: (env: Environment) => Loader): Promise<void> {
  const base = ld.env.withContext({ ...ld.env.context, default_company_id: company, allowed_company_ids: [company], install_mode: true }).sudo();
  const data = await demoData(makeLoader(base), company);
  await loadData(makeLoader(base.withContext({ ...base.context, skip_pdf_attachment_generation: true })), data);
  const pl = makeLoader(base);
  await postLoadDemoData(base, pl, code);
  // the activities' `res_name` (mail_activity.py:167-172, stored, depends on res_model and res_id): Odoo computes it at
  // the first flush of mail.activity after the loader's delayed write of res_id, which nothing before the end of
  // `_post_load_demo_data` causes, so it is the posted moves' names; the port computed it at the write
  const activities: number[] = [];
  for (const key of data.get("mail.activity")?.keys() ?? []) {
    const id = await pl.ref(String(key), false);
    if (id !== null) activities.push(id);
  }
  for (const id of activities) {
    const r = (await base.cr.query<{ model: string | null; res_id: number | null; res_name: string | null }>("SELECT res_model AS model, res_id, res_name FROM mail_activity WHERE id = $1", [id])).rows[0];
    if (!r?.model || !r.res_id) continue;
    const name = (await base.sudo().model(r.model).displayName([r.res_id])).get(r.res_id) ?? null;
    if (name !== r.res_name) await base.cr.query("UPDATE mail_activity SET res_name = $2 WHERE id = $1", [id, name]);
  }
}
