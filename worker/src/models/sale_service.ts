/**
 * sale_project sale_order_line.py:332-426 `_timesheet_service_generation` at confirmation (sale_order.py:148-176
 * `_action_confirm`, run as sudo in the order's company before the stock rules) for `task_global_project` lines: the
 * order takes the product's project, a task is created in it per line (:251-276 `_timesheet_create_task_prepare_values`,
 * :303-324 `_timesheet_create_task` with its "This task has been created from" note). Lines that create projects
 * (project_only, task_in_project), task templates and milestones refuse.
 */
import { NotPorted } from "../errors";
import { computeAuthor, insertMessages, replyToDefault, trackingMessageId, xmlid } from "../mail/message";
import { assertNoRecipients } from "../mail/post";
import { flatThreadParent } from "../mail/thread_generic";
import { create } from "../orm/create";
import type { Environment } from "../orm/types";
import { write } from "../orm/write";

interface ServiceLine {
  id: number; sequence: number; name: string | null; qty: number; tracking: string; project_json: Record<string, number> | null;
  task_template: number | null; project_template: number | null; task_id: number | null; project_id: number | null;
  is_optional: boolean | null; product_name: string; product_display: string; invoice_policy: string | null; service_type: string | null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

export async function timesheetServiceGeneration(env: Environment, orderId: number): Promise<void> {
  if (env.context["disable_project_task_generation"]) return;
  const [order] = (await env.cr.query<{ name: string; company_id: number; project_id: number | null; partner_id: number }>(
    "SELECT name, company_id, project_id, partner_id FROM sale_order WHERE id = $1", [orderId])).rows;
  const lines = (await env.cr.query<ServiceLine>(
    `SELECT l.id, l.sequence, l.name, l.product_uom_qty::float8 AS qty, t.service_tracking AS tracking, t.project_id AS project_json, t.task_template_id AS task_template,
            t.project_template_id AS project_template, l.task_id, l.project_id, l.is_optional, t.name->>'en_US' AS product_name, t.invoice_policy, t.service_type,
            CASE WHEN t.default_code IS NOT NULL THEN '[' || t.default_code || '] ' || (t.name->>'en_US') ELSE t.name->>'en_US' END AS product_display
       FROM sale_order_line l JOIN product_product p ON p.id = l.product_id JOIN product_template t ON t.id = p.product_tmpl_id
      WHERE l.order_id = $1 AND l.is_service AND t.service_tracking IN ('project_only', 'task_in_project', 'task_global_project') ORDER BY l.sequence, l.id`, [orderId])).rows
    .filter((l) => !(l.is_optional && l.qty === 0));
  if (!lines.length) return;
  if (lines.some((l) => l.tracking !== "task_global_project")) throw new NotPorted("sale order lines creating projects (project_only, task_in_project: _timesheet_create_project)");
  if (lines.some((l) => l.task_template !== null)) throw new NotPorted("service lines with a task template (action_create_from_template)");
  if (lines.some((l) => l.invoice_policy === "delivery" && l.service_type === "milestones")) throw new NotPorted("service lines invoiced on milestones (_handle_milestones)");
  if ((env.lang ?? "en_US") !== "en_US") throw new NotPorted("the service task note in another language");
  // :350-352 `product_id.with_company(sol.company_id).project_id` (company-dependent)
  const projectOf = (l: ServiceLine): number | null => (l.project_json ? l.project_json[String(order!.company_id)] ?? null : null);
  // :399-402 the order takes the first line's project
  let orderProject = order!.project_id;
  for (const l of lines) {
    if (!orderProject && projectOf(l)) {
      orderProject = projectOf(l);
      await write(env, "sale.order", [orderId], { project_id: orderProject });
    }
  }
  for (const l of lines) {
    if (l.task_id) continue;
    const project = projectOf(l) ?? orderProject;
    if (!project || !(l.qty > 0)) continue;
    const [p] = (await env.cr.query<{ sale_line_id: number | null; company_id: number | null }>("SELECT sale_line_id, company_id FROM project_project WHERE id = $1", [project])).rows;
    // :251-276
    const parts = (l.name ?? "").split("\n");
    const single = parts.length === 1 && parts[0];
    const title = single ? parts[0]! : l.product_display;
    const description = single ? "" : parts.map(esc).join("<br/>");
    const [task] = await create(env.sudo(), "project.task", [{
      name: p!.sale_line_id ? title : `${order!.name || ""} - ${title}`, allocated_hours: l.qty, partner_id: order!.partner_id,
      description, project_id: project, sale_line_id: l.id, sale_order_id: orderId, company_id: p!.company_id ?? false, user_ids: false,
    }]);
    await write(env, "sale.order.line", [l.id], { task_id: task });
    // :318-323 `task.message_post(body=...)` (mt_note, a Markup body)
    const note = await xmlid(env, "mail.mt_note");
    await assertNoRecipients(env, "project.task", task!, note, []);
    const [authorId, emailFrom] = await computeAuthor(env, null, null);
    const body = `<p>This task has been created from: <a href="#" data-oe-model="sale.order" data-oe-id="${orderId}">${esc(order!.name)}</a> (${esc(l.product_name)})</p>`;
    await insertMessages(env, [{
      model: "project.task", res_id: task!, body, author_id: authorId, email_from: emailFrom, message_type: "notification", subject: false,
      // `_mail_get_companies(default=env.company)`: a task without company records the environment's
      subtype_id: note, email_add_signature: true, record_company_id: p!.company_id ?? await env.company(), parent_id: await flatThreadParent(env, "project.task", task!),
      message_id: trackingMessageId("message-notify"), reply_to: await replyToDefault(env, emailFrom),
    }]);
  }
  // sale_order.py:161-167: projects reinvoiced to the order without a sale line get the first service line
  const reinvoiced = (await env.cr.query("SELECT 1 FROM project_project WHERE reinvoiced_sale_order_id = $1 AND sale_line_id IS NULL LIMIT 1", [orderId])).rows.length;
  if (reinvoiced) throw new NotPorted("projects reinvoiced to the order without a sale line");
}
