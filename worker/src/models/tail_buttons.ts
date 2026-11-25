/**
 * Form header buttons and actions (`/web/dataset/call_button`) of sale.order, calendar.event, crm.team and
 * crm.iap.lead.mining.request, as far as the API corpus reaches them in poc_erp. Each body follows the Python method
 * and refuses the branches that need more of Odoo (stock cancellation, invoices, lead assignment, IAP requests).
 */
import { randomUUID } from "node:crypto";
import { MissingError, NotPorted, UserError } from "../errors";
import { registerMethod } from "../http/methods";
import { checkModelAccess } from "../orm/access";
import { hasGroup } from "../orm/env";
import { write } from "../orm/write";
import type { Environment } from "../orm/types";
import { envFor } from "../web/common";
import { companyHasLayout, configureExternalReportLayout, fetchRecords, isAdmin } from "./account_buttons";
import { configParam } from "./tail_util";
import { translate } from "./util";
import { cancelOrders, confirmOrders, orderStateChanged } from "./sale_confirm";

function ensureOne(ids: readonly number[] | null, model: string): number {
  if (ids === null || ids.length !== 1) throw new NotPorted(`ensure_one on ${model}(${(ids ?? []).join(", ")})`);
  return ids[0]!;
}

type ButtonFn = (env: Environment, ids: number[], kwargs: Record<string, unknown>) => Promise<unknown>;
function button(model: string, method: string, fn: ButtonFn): void {
  registerMethod(model, method, async (env0, ids, _args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], kwargs);
  }, { apiModel: false });
}

/** models.py check_access('write') through payment_utils.check_rights_on_recordset (payment/utils.py:273-282). */
async function checkWrite(env: Environment, model: string, ids: readonly number[]): Promise<void> {
  await fetchRecords(env, model, ids, ["id"]);
  await env.model(model).checkAccess(ids, "write");
}

// ----------------------------------------------------------------------------------------------------------------
// sale.order (odoo/addons/sale/models/sale_order.py)
// ----------------------------------------------------------------------------------------------------------------

button("sale.order", "action_confirm", async (env, ids) => {
  // :1619-1631 with :1656-1662 _confirmation_error_message
  const orders = await fetchRecords(env, "sale.order", ids, ["state"]);
  for (const o of orders) {
    if (o["state"] !== "draft" && o["state"] !== "sent") throw new UserError(translate(env, "Some orders are not in a state requiring confirmation."));
  }
  await confirmOrders(env, ids);
  return true; // :1631 (sale_crm, sale_management, sale_project return super's value)
});

button("sale.order", "action_unlock", async (env, ids) => {
  // :1788-1789
  await write(env, "sale.order", ids, { locked: false });
  return null;
});

button("sale.order", "action_cancel", async (env, ids) => {
  // :1791-1800 with sale_stock sale_order.py `_action_cancel`
  const orders = await fetchRecords(env, "sale.order", ids, ["locked"]);
  if (orders.some((o) => o["locked"])) throw new UserError(translate(env, "You cannot cancel a locked order. Please unlock it first."));
  await cancelOrders(env, ids);
  return true;
});

button("sale.order", "action_draft", async (env, ids) => {
  // :1516-1523
  const orders = await fetchRecords(env, "sale.order", ids, ["state"]);
  const todo = orders.filter((o) => o["state"] === "cancel" || o["state"] === "sent").map((o) => Number(o["id"]));
  if (todo.length) {
    await write(env, "sale.order", todo, { state: "draft", signature: false, signed_by: false, signed_on: false });
    await orderStateChanged(env, todo);
  }
  return true;
});

button("sale.order", "action_reopen_order", async (env, ids) => {
  // :1777-1783: orders with invoicing closed reopen and log a message (the message log is not ported)
  const orders = await fetchRecords(env, "sale.order", ids, ["invoicing_closed"]);
  if (orders.some((o) => o["invoicing_closed"])) throw new NotPorted("sale.order.action_reopen_order of closed orders (_message_log_batch)");
  return null;
});

/** portal_mixin.py:34-39 _portal_ensure_token: an uuid4 written as superuser when missing. */
async function ensureToken(env: Environment, model: string, id: number): Promise<string> {
  const [row] = await env.sudo().model(model).read([id], ["access_token"], "");
  const token = row?.["access_token"];
  if (typeof token === "string" && token) return token;
  const fresh = randomUUID();
  await write(env.sudo(), model, [id], { access_token: fresh });
  return fresh;
}

button("sale.order", "action_quotation_send", async (env, ids) => {
  // :1525-1576 with :1577-1607 _find_mail_template
  const orders = await fetchRecords(env, "sale.order", ids, ["state"]);
  // :1527-1529 order_line._validate_analytic_distribution (sale_order_line.py:2093-2101, analytic_mixin.py:182-196):
  // only with `validate_analytic` in the context, and only against mandatory plans; with none it does nothing. A plan
  // is mandatory by its default or by a rule scoring above it (analytic_plan.py:244-270); a rule of another business
  // domain scores -1 (:447-456, account_analytic_plan.py:58-75)
  if (orders.some((o) => o["state"] === "draft" || o["state"] === "sent") && env.context["validate_analytic"]) {
    const mandatory = (await env.cr.query(
      `SELECT 1 FROM account_analytic_applicability WHERE applicability = 'mandatory' AND business_domain = 'sale_order'
       UNION ALL SELECT 1 FROM account_analytic_plan WHERE default_applicability::text LIKE '%mandatory%' LIMIT 1`)).rows.length;
    if (mandatory) throw new NotPorted("sale.order.action_quotation_send with mandatory analytic plans (_validate_analytic_distribution)");
  }
  const ctx: Record<string, unknown> = {
    default_model: "sale.order", default_res_ids: [...ids], default_composition_mode: "comment",
    email_notification_allow_footer: true, hide_mail_template_management_options: true,
    proforma: env.context["proforma"] ?? false,
  };
  for (const id of ids) await ensureToken(env, "sale.order", id);
  if (ids.length > 1) ctx["default_composition_mode"] = "mass_mail";
  else {
    ctx["force_email"] = true;
    if (!env.context["hide_default_template"]) {
      let template: number | null;
      if (env.context["proforma"]) template = await env.reg.xmlid(env.cr, "sale.email_template_proforma");
      else if (orders[0]!["state"] !== "sale") template = await env.reg.xmlid(env.cr, "sale.email_template_edi_sale");
      else {
        // :1593-1607 _get_confirmation_template
        const raw = await configParam(env, "sale.default_confirmation_template");
        const configured = raw !== null && /^-?\d+$/.test(raw.trim()) ? Number(raw) : 0;
        const exists = configured ? (await env.cr.query("SELECT 1 FROM mail_template WHERE id = $1", [configured])).rows.length > 0 : false;
        template = exists ? configured : await env.reg.xmlid(env.cr, "sale.mail_template_sale_confirmation");
      }
      if (template) Object.assign(ctx, { default_template_id: template, mark_so_as_sent: true });
    }
  }
  const action: Record<string, unknown> = {
    name: translate(env, "Send"), type: "ir.actions.act_window", view_mode: "form", res_model: "mail.compose.message",
    views: [[false, "form"]], view_id: false, target: "new", context: ctx,
  };
  // :1561-1574 the layout configurator first, for an admin of a company without a report layout
  if (env.context["check_document_layout"] && !env.context["discard_logo_check"] && await isAdmin(env) && !(await companyHasLayout(env))) {
    const layout = await configureExternalReportLayout(env, action);
    delete action["close_on_report_download"];
    (layout["context"] as Record<string, unknown>)["dialog_size"] = "extra-large";
    return layout;
  }
  return action;
});

button("sale.order", "action_preview_sale_order", async (env, ids) => {
  // :1802-1806 with portal_mixin.py:121-147 get_portal_url and sale_order.py:1217-1220 access_url
  const id = ensureOne(ids, "sale.order");
  await fetchRecords(env, "sale.order", [id], ["id"]);
  const base = (await configParam(env, "web.base.url")) ?? "";
  const token = await ensureToken(env, "sale.order", id);
  // urljoin(base, '/my/orders/<id>?access_token=...'): the absolute path replaces the base's path
  const url = new URL(`/my/orders/${id}?access_token=${token}`, base.endsWith("/") ? base : `${base}/`).toString();
  return { type: "ir.actions.act_url", target: "new", url };
});

/** payment_transaction.py:447-471 _build_action_feedback_notification of no failed transaction. */
function paymentSuccess(env: Environment): Record<string, unknown> {
  return {
    type: "ir.actions.client", tag: "display_notification",
    params: { type: "success", message: translate(env, "Your payment operation has been successfully submitted."), next: { type: "ir.actions.act_window_close" } },
  };
}

button("sale.order", "payment_action_capture", async (env, ids) => {
  // sale_order.py:2301-2307, payment_transaction.py:373-400 action_capture: ported without transactions
  const id = ensureOne(ids, "sale.order");
  await checkWrite(env, "sale.order", [id]);
  const n = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM sale_order_transaction_rel WHERE sale_order_id = $1", [id])).rows[0]?.n ?? "0";
  if (Number(n) > 0) throw new NotPorted("sale.order.payment_action_capture with transactions");
  return paymentSuccess(env);
});

button("sale.order", "payment_action_void", async (env, ids) => {
  // sale_order.py:2309-2314, payment_transaction.py:402-424 action_void: ported without authorized transactions
  await checkWrite(env, "sale.order", ids);
  const n = (await env.cr.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sale_order_transaction_rel r JOIN payment_transaction t ON t.id = r.transaction_id
      WHERE r.sale_order_id = ANY($1::int[]) AND t.state = 'authorized'`, [ids])).rows[0]?.n ?? "0";
  if (Number(n) > 0) throw new NotPorted("sale.order.payment_action_void with authorized transactions");
  return null;
});

// ----------------------------------------------------------------------------------------------------------------
// calendar.event (odoo/addons/calendar/models/calendar_event.py)
// ----------------------------------------------------------------------------------------------------------------

button("calendar.event", "action_open_composer", async (env, ids) => {
  // :1508-1531
  const rows = await fetchRecords(env, "calendar.event", ids, ["partner_ids"]);
  const partners: number[] = [];
  for (const r of rows) for (const p of (Array.isArray(r["partner_ids"]) ? r["partner_ids"] : []) as number[]) if (!partners.includes(p)) partners.push(p);
  if (partners.length === 0) throw new UserError(translate(env, "There are no attendees on these events"));
  const template = (await env.reg.xmlid(env.cr, "calendar.calendar_template_meeting_update")) ?? false;
  const mode = env.context["default_composition_mode"] ?? env.context["composition_mode"] ?? "comment";
  const tz = (await env.cr.query<{ tz: string | null }>(
    "SELECT p.tz FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = $1", [env.uid])).rows[0]?.tz ?? false;
  return {
    type: "ir.actions.act_window", name: translate(env, "Contact Attendees"), view_mode: "form", res_model: "mail.compose.message",
    views: [[false, "form"]], view_id: false, target: "new",
    context: { default_composition_mode: mode, default_model: "calendar.event", default_res_ids: [...ids], default_template_id: template, default_partner_ids: partners, mail_tz: tz || false },
  };
});

button("calendar.event", "action_confirm", async (env, ids) => {
  // :1232-1237
  await write(env, "calendar.event", ids, { is_draft: false });
  await write(env, "calendar.event", ids, { show_as: "busy" });
  return null;
});

// ----------------------------------------------------------------------------------------------------------------
// crm.team, crm.iap.lead.mining.request
// ----------------------------------------------------------------------------------------------------------------

button("crm.team", "action_assign_leads", async (env) => {
  // crm_team.py:211-222 -> :248-267 _action_assign_leads: managers or administrators only (env.is_system:
  // superuser or base.group_system)
  if (!(await hasGroup(env, "sales_team.group_sale_manager") || env.su || await hasGroup(env, "base.group_system"))) {
    throw new UserError(translate(env, "Lead/Opportunities automatic assignment is limited to managers or administrators"));
  }
  throw new NotPorted("crm.team lead assignment (_allocate_leads, _assign_and_convert_leads)");
});

button("crm.iap.lead.mining.request", "action_submit", async (env, ids) => {
  // crm_iap_lead_mining_request.py:270-273: ensure_one, then `self.name` reads the record (read access, then
  // MissingError for a deleted request); the IAP request itself is not ported
  const id = ensureOne(ids, "crm.iap.lead.mining.request");
  await checkModelAccess(env, env.reg.model("crm.iap.lead.mining.request"), "read");
  const rows = await env.model("crm.iap.lead.mining.request").read([id], ["name"], "");
  if (rows.length === 0) throw new MissingError(`Record does not exist or has been deleted.\n(Record: crm.iap.lead.mining.request(${id},), User: ${env.uid})`);
  throw new NotPorted("crm.iap.lead.mining.request.action_submit (IAP lead mining request)");
});
