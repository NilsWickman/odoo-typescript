/**
 * `get_empty_list_help(help)` of the action's model, applied by `ir.actions.act_window.read` to `help`
 * (odoo/addons/base/models/ir_actions.py:325-339) with the action's evaluated context. The base hook returns the
 * help unchanged (ir_ui_view.py:2813); ported overrides: mail.thread (mail/models/mail_thread.py:441-488, for
 * every mail.thread model) and crm.lead (crm/models/crm_lead.py:1356-1417). Models of the source tree with other
 * overrides raise NotPorted.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import { renderTemplate } from "../qweb";
import { translateLang } from "../models/util";

/** odoo/tools/mail.py:525-538 `is_html_empty`. */
export function isHtmlEmpty(html: unknown): boolean {
  if (typeof html !== "string" || html === "") return true;
  const iconRe = /<\s*(i|span)\b(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"])?)*\s*\bclass\s*=\s*["'][^"']*\b(fa|fab|fad|far|oi)\b/;
  const tagRe = /<\s*\/?(?:p|div|section|span|br|b|i|font)\b(?:(\s+[A-Za-z_-][A-Za-z0-9-_]*(\s*=\s*['"][^"']*['"]))*)(?:\s*>|\s*\/\s*>)/g;
  const text = unescapeHtml(html.replace(tagRe, ""));
  return text.trim() === "" && !iconRe.test(html);
}

/** html.unescape for the entities that can make text non-empty (named basics and numeric references). */
function unescapeHtml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|nbsp);?/g, (m, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " } as Record<string, string>)[e] ?? m;
  });
}

/** Models whose get_empty_list_help override is not ported (grep `def get_empty_list_help` in odoo/addons). */
const UNPORTED = new Set(["mail.gateway.allowed", "hr.expense", "mrp.production", "hr.applicant"]);

export interface HelpEnv {
  readonly cr: Cursor;
  readonly uid: number;
  /** The action context evaluated over the env context (ir_actions.py:333-338). */
  readonly context: Readonly<Record<string, unknown>>;
  /** `env.company.id`. */
  readonly companyId: number;
  readonly lang: string;
}

export async function getEmptyListHelp(env: HelpEnv, model: string, help: string | false): Promise<string | false> {
  if (UNPORTED.has(model)) throw new NotPorted(`${model}.get_empty_list_help`);
  if (model === "crm.lead") return crmLeadHelp(env, help);
  if (model === "crm.iap.lead.mining.request") {
    // crm_iap_mine/models/crm_iap_lead_mining_request.py:156-164, then super() (mail.thread's, or the base identity)
    if (!isHtmlEmpty(help)) return help;
    if (env.lang !== "en_US") throw new NotPorted("crm.iap.lead.mining.request.get_empty_list_help outside en_US");
    return mailThreadHelp(env, model, '<p class="o_view_nocontent_smiling_face">Create a Lead Mining Request</p>'
      + '<p class="oe_view_nocontent_alias">Generate new leads based on their country, industry, size, etc.</p>');
  }
  if (model === "product.template" || model === "product.product") {
    // product_template.py:1800-1804, product_product.py:1375-1379: document name "product", then mail.thread's
    return mailThreadHelp({ ...env, context: { ...env.context, empty_list_help_document_name: translateLang(env.lang, "product", "product") } }, model, help);
  }
  if (model === "stock.picking") {
    // stock_picking.py:617-622: the help is the stock.help_message_template rendering (on the empty recordset,
    // picking_type_code is False unless restricted_picking_type_code is in the context)
    const code = env.context["restricted_picking_type_code"] || false;
    return renderTemplate(env.cr, "stock.help_message_template", { picking_type_code: code }, { lang: env.lang });
  }
  if (model === "sale.order") {
    // sale/models/sale_order.py:2458-2460: document name "sale order"
    return mailThreadHelp({ ...env, context: { ...env.context, empty_list_help_document_name: translateLang(env.lang, "sale order", "sale") } }, model, help);
  }
  if (model === "project.task") {
    // project/models/project_task.py:1013-1025: "task", or the project's label_tasks; the project is the alias holder
    const projectId = env.context["default_project_id"] || false;
    let tname = translateLang(env.lang, "task", "project");
    if (projectId) {
      if (typeof projectId !== "number") throw new NotPorted("project.task.get_empty_list_help default_project_id value");
      const label = (await env.cr.query<{ l: string | null }>("SELECT COALESCE(label_tasks->>$2, label_tasks->>'en_US') AS l FROM project_project WHERE id = $1", [projectId, env.lang])).rows[0]?.l;
      if (label) tname = label.toLowerCase();
    }
    return mailThreadHelp({ ...env, context: { ...env.context, empty_list_help_id: projectId || false, empty_list_help_model: "project.project", empty_list_help_document_name: tname } }, model, help);
  }
  return mailThreadHelp(env, model, help);
}

async function isMailThread(cr: Cursor, model: string): Promise<boolean> {
  const r = await cr.query<{ t: boolean | null }>("SELECT is_mail_thread AS t FROM ir_model WHERE model = $1", [model]);
  return r.rows[0]?.t === true;
}

/**
 * mail/models/mail_thread.py:441-488. The document name is translated by the model that sets it (`_("sale order")`,
 * `_("product")`, the task label) and the generated message by mail's `_()`.
 */
async function mailThreadHelp(env: HelpEnv, model: string, help: string | false): Promise<string | false> {
  if (!(await isMailThread(env.cr, model))) return help; // BaseModel (ir_ui_view.py:2813)
  if (env.context["empty_list_help_model"]) {
    // :449-468: an alias needs a record (empty_list_help_id) or the company's alias domain
    const domain = (await env.cr.query<{ d: number | null }>("SELECT alias_domain_id AS d FROM res_company WHERE id = $1", [env.companyId])).rows[0]?.d ?? null;
    if (domain !== null) throw new NotPorted("mail.thread.get_empty_list_help alias lookup");
    const resId = env.context["empty_list_help_id"];
    if (resId) {
      // :451-458 the record's alias counts only with an alias domain (alias_domain, related alias_domain_id.name)
      const table = String(env.context["empty_list_help_model"]).replace(/\./g, "_");
      const hasAlias = (await env.cr.query(
        `SELECT 1 FROM "${table}" r JOIN mail_alias a ON a.id = r.alias_id WHERE r.id = $1 AND a.alias_name IS NOT NULL AND a.alias_domain_id IS NOT NULL`,
        [resId])).rows.length;
      if (hasAlias) throw new NotPorted("mail.thread.get_empty_list_help alias message");
    }
  }
  if (isHtmlEmpty(help)) {
    const doc = env.context["empty_list_help_document_name"];
    // :446 the default is mail's `_('document')`
    const name = typeof doc === "string" ? doc : translateLang(env.lang, "document", "mail");
    // :486-488 _("Create new %(document)s", document=html_escape(document_name))
    const escaped = name.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&#34;").replace(/'/g, "&#39;");
    return `<p class='o_view_nocontent_smiling_face'>${translateLang(env.lang, "Create new %(document)s", "mail").replace("%(document)s", escaped)}</p>`;
  }
  return help;
}

/** crm/models/crm_lead.py:1356-1417 (then super(): mail.thread). */
async function crmLeadHelp(env: HelpEnv, help: string | false): Promise<string | false> {
  const _ = (source: string): string => translateLang(env.lang, source, "crm");
  const title = env.context["default_type"] === "lead" ? _("Create a new lead") : _("Create an opportunity to start playing with your pipeline.");
  const newHelp = `<p class='o_view_nocontent_smiling_face'>${title}</p>`;
  const empty = isHtmlEmpty(help);
  const u = await env.cr.query<{ sale_team_id: number | null }>("SELECT sale_team_id FROM res_users WHERE id = $1", [env.uid]);
  if (!(u.rows[0]?.sale_team_id) && (empty || env.context["crm_lead_prioritize_team_help"])
    // `crm.team.search_count([], limit=1)`: the action is read as superuser (active_test only)
    && (await env.cr.query("SELECT 1 FROM crm_team WHERE active LIMIT 1")).rows.length) {
    const subTitle = _("As you are a member of no Sales Team, you are showed the entire Pipeline.<br/>");
    // has_group('sales_team.group_sale_manager'): the user's groups and their implied groups
    const manager = (await env.cr.query(
      `WITH RECURSIVE g(id) AS (SELECT gid FROM res_groups_users_rel WHERE uid = $1
         UNION SELECT r.hid FROM res_groups_implied_rel r JOIN g ON r.gid = g.id)
       SELECT 1 FROM g JOIN ir_model_data d ON d.res_id = g.id AND d.model = 'res.groups'
        AND d.module = 'sales_team' AND d.name = 'group_sale_manager'`, [env.uid])).rows.length > 0;
    let suffix: string;
    if (manager) {
      const action = (await env.cr.query<{ res_id: number }>(
        "SELECT res_id FROM ir_model_data WHERE module = 'sales_team' AND name = 'crm_team_action_config'")).rows[0]?.res_id;
      suffix = _('To work with the CRM, you should <a name="%d" type="action" tabindex="-1">join a Team.</a>').replace("%d", String(action));
    } else {
      suffix = _("To work with the CRM, you should be added to a Team.");
    }
    return `${newHelp}<p>${subTitle} ${suffix}</p>`;
  }
  if (!empty) return mailThreadHelp(env, "crm.lead", help);
  // alias_domain (:1402-1407): teams of the company or none, with an alias name, aliasing crm.lead
  const teams = await env.cr.query<{ id: number; alias_domain_id: number | null }>(
    `SELECT t.id, a.alias_domain_id FROM crm_team t JOIN mail_alias a ON a.id = t.alias_id JOIN ir_model m ON m.id = a.alias_model_id
      WHERE t.active AND (t.company_id = $1 OR t.company_id IS NULL) AND a.alias_name IS NOT NULL AND a.alias_name != ''
        AND m.model = 'crm.lead'`, [env.companyId]);
  if (teams.rows.some((t) => t.alias_domain_id !== null)) {
    throw new NotPorted("crm.lead.get_empty_list_help with a team alias on a domain (alias_email sub title)");
  }
  return mailThreadHelp(env, "crm.lead", `${newHelp}<p class="oe_view_nocontent_alias"></p>`);
}
