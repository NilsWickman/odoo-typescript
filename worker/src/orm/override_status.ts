/**
 * What the port does with each Python `create`/`write`/`unlink` override and `@api.ondelete` method of the templates
 * (gen/write_overrides.py -> gen/out[/poc_erp]/write_overrides.json), for the guard of src/orm/override_guard.ts.
 * Key: `<method> <python module without odoo.addons.>:<class>`, for ondelete `ondelete <module>:<class>.<method>`.
 * A class that is not listed refuses (NotPorted) every client call of the method on a model that has it.
 *
 * Each entry was decided by reading the Odoo source it names (`src`) against the port: `ported` says where the port
 * has it; `when` lists the value keys for which the override acts and the port has nothing (the call refuses with
 * them); `acts` decides on the records for an effect that depends on data (the call refuses when it holds).
 */
import type { OverrideStatus } from "./override_guard";
import type { Environment } from "./types";
import { NotPorted } from "../errors";
import * as priv from "./dispatch_gen";

async function exists(env: Environment, query: string, params: unknown[]): Promise<boolean> {
  return (await env.cr.query(query, params)).rows.length > 0;
}

/** The ids of the records of these xml ids that exist (`env.ref(xmlid, raise_if_not_found=False)`). */
async function xmlidIds(env: Environment, xmlids: readonly string[]): Promise<number[]> {
  const out: number[] = [];
  for (const x of xmlids) {
    const id = await env.reg.xmlid(env.cr, x);
    if (typeof id === "number") out.push(id);
  }
  return out;
}

/**
 * mail_activity_type.py:163-176 `_get_model_info_by_xmlid`, mail's: the master activity types by xml id, with the model
 * they keep and whether they may be deleted. The hand implementation of the dispatch map's entry: a module's compiled
 * override (fleet's contract renewal type, hr_holidays' approvals) adds its own around it.
 */
export async function modelInfoByXmlidHand(_env: Environment): Promise<Record<string, { res_model: string | false; unlink: boolean }>> {
  return {
    "mail.mail_activity_data_call": { res_model: false, unlink: false },
    "mail.mail_activity_data_meeting": { res_model: false, unlink: false },
    "mail.mail_activity_data_todo": { res_model: false, unlink: false },
    "mail.mail_activity_data_upload_document": { res_model: false, unlink: true },
    "mail.mail_activity_data_warning": { res_model: false, unlink: true },
  };
}

/** `self._get_model_info_by_xmlid()` through the dispatch: the master types, an override's included. */
async function modelInfoByXmlid(env: Environment): Promise<[string, { res_model: string | false; unlink: boolean }][]> {
  const v = await priv.mail_activity_type._get_model_info_by_xmlid.invoke(env);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new NotPorted(`mail.activity.type._get_model_info_by_xmlid giving ${JSON.stringify(v)}`);
  return Object.entries(v as Record<string, unknown>).map(([x, i]) => {
    const r = i as Record<string, unknown> | null;
    if (r === null || typeof r !== "object" || !(r["res_model"] === false || typeof r["res_model"] === "string") || typeof r["unlink"] !== "boolean") {
      throw new NotPorted(`mail.activity.type._get_model_info_by_xmlid giving ${JSON.stringify(i)} for ${x}`);
    }
    return [x, { res_model: r["res_model"] as string | false, unlink: r["unlink"] as boolean }];
  });
}

/** The x2many command values of `field` in the values (create and update commands). */
function commandValues(valsList: readonly Readonly<Record<string, unknown>>[], field: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const vals of valsList) {
    const cmds = vals[field];
    if (!Array.isArray(cmds)) continue;
    for (const c of cmds) if (Array.isArray(c) && (c[0] === 0 || c[0] === 1) && c[2] && typeof c[2] === "object") out.push(c[2] as Record<string, unknown>);
  }
  return out;
}

const SALE_LINE_READS = ["order_id", "product_id", "is_expense"];

/**
 * A line of the values (not an expense) is on a confirmed order (the order given, the default's, or the order written
 * through the inverse key the guard adds) and its product is a service the module generates something for:
 * `subcontract` (sale_purchase `_purchase_service_generation`, sale_order_line.py:295), `project` (sale_project
 * `_timesheet_service_generation`, :339-344: project_only, task_in_project, task_global_project).
 */
async function confirmedOrder(env: Environment, valsList: readonly Readonly<Record<string, unknown>>[], service: "subcontract" | "project"): Promise<boolean> {
  const tracking = service === "subcontract" ? ["subcontract"] : ["project_only", "task_in_project", "task_global_project"];
  for (const v of valsList) {
    const order = idOf(v["order_id"]), product = idOf(v["product_id"]);
    if (order === null || order <= 0 || product === null || v["is_expense"]) continue;
    if (await exists(env, `SELECT 1 FROM sale_order o, product_product p JOIN product_template t ON t.id = p.product_tmpl_id
         WHERE o.id = $1 AND o.state = 'sale' AND p.id = $2 AND t.service_tracking = ANY($3::text[])`, [order, product, tracking])) return true;
  }
  return false;
}

/** The id of a many2one value (an id, a pair from a read, or false). */
function idOf(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (Array.isArray(v) && typeof v[0] === "number") return v[0];
  return null;
}

/** The ids an x2many value links (SET, LINK and the plain list of the web client), for a "has members" test. */
function linkedIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (const c of value) {
    if (typeof c === "number") out.push(c);
    else if (Array.isArray(c) && c[0] === 4 && typeof c[1] === "number") out.push(c[1]);
    else if (Array.isArray(c) && c[0] === 6 && Array.isArray(c[2])) out.push(...(c[2] as unknown[]).filter((x): x is number => typeof x === "number"));
    else if (Array.isArray(c) && c[0] === 0) out.push(0);
  }
  return out;
}

/** One of the parameters has one of these keys. */
function paramKeys(env: Environment, ids: readonly number[], keys: readonly string[]): Promise<boolean> {
  return exists(env, "SELECT 1 FROM ir_config_parameter WHERE id = ANY($1::int[]) AND key = ANY($2::text[]) LIMIT 1", [[...ids], [...keys]]);
}

const MAIL_THREAD = "the mail.thread hooks (src/mail/write_hooks.ts threadHooks, src/models/crm_lead_mail.ts) of every concrete mail.thread model of the templates";

export const OVERRIDE_STATUS: Readonly<Record<string, OverrideStatus>> = {
  // ------------------------------------------------------------------------------------------------ generic mixins
  "create mail.models.mail_thread:MailThread": { ported: MAIL_THREAD, src: "mail/models/mail_thread.py:271" },
  "write mail.models.mail_thread:MailThread": { ported: MAIL_THREAD, src: "mail/models/mail_thread.py:334" },
  "unlink mail.models.mail_thread:MailThread": { ported: MAIL_THREAD, src: "mail/models/mail_thread.py:424" },
  "create mail.models.mail_mail:MailMail": { ported: "src/mail/mail_mail_create.ts", src: "mail/models/mail_mail.py:152-172" },
  "write mail.models.mail_mail:MailMail": { ported: "src/mail/mail_mail_create.ts", src: "mail/models/mail_mail.py:174-181" },
  "write mail.models.mail_track_mixin:MailTrackMixin": {
    ported: "trackPrepare in the mail.thread hooks; account.move.line: prepareLineTracking (src/models/account_integrity.ts)",
    src: "mail/models/mail_track_mixin.py:29",
  },
  "unlink mail.models.models:Base": {
    ported: "the activities of the deleted records (src/orm/unlink.ts unlinkActivities, after the mail.thread hooks)",
    src: "mail/models/models.py:48",
  },
  "unlink rating.models.mail_thread:MailThread": { ported: "threadAfterUnlink (src/mail/write_hooks.ts)", src: "rating/models/mail_thread.py:18" },
  "write rating.models.rating_mixin:RatingMixin": {
    ported: "the project.task write hook of src/models/rating_computes.ts", models: ["project.task"],
    src: "rating/models/rating_mixin.py:99 (project.task: _rec_name name, _rating_get_parent_field_name project_id)",
  },
  "create analytic.models.analytic_mixin:AnalyticMixin": { ported: "sanitizeAnalytic (src/orm/create.ts)", src: "analytic/models/analytic_mixin.py:175" },
  "write analytic.models.analytic_mixin:AnalyticMixin": { ported: "sanitizeAnalytic (src/orm/write.ts)", src: "analytic/models/analytic_mixin.py:169" },
  // an in-process cache of the last sequence (`_get_sequence_cache().clear()`): the port keeps none
  "write account.models.sequence_mixin:SequenceMixin": { ported: "no sequence cache in the port", src: "account/models/sequence_mixin.py:115" },
  // `vals.pop('html_field_history')` before create: ported in src/models/html_field_history.ts
  "create html_editor.models.html_field_history_mixin:HtmlFieldHistoryMixin": {
    ported: "src/models/html_field_history.ts", models: ["project.task"],
    src: "html_editor/models/html_field_history_mixin.py:42",
  },
  // a new revision (patch) of the versioned fields (project.task: description) is stored in html_field_history
  "write html_editor.models.html_field_history_mixin:HtmlFieldHistoryMixin": {
    ported: "src/models/html_field_history.ts", models: ["project.task"],
    src: "html_editor/models/html_field_history_mixin.py:48 (project_task.py:111)",
  },
  // the creator must be in the mail editor group for a dynamic template, only where `_unrestricted_rendering` is set
  // (mail.template, sms.template: not listed, refused); the composers and wizards render restricted
  "create mail.models.mail_render_mixin:MailRenderMixin": {
    ported: "no check where _unrestricted_rendering is False; mail.template: src/models/mail_template_write.ts", models: ["account.move.send.wizard", "calendar.event.archive.or.unlink.wizard", "mail.compose.message", "mail.template"],
    src: "mail/models/mail_render_mixin.py:109",
  },
  // mail.template (`_unrestricted_rendering`): the editor-group check in src/models/mail_template_write.ts
  "write mail.models.mail_render_mixin:MailRenderMixin": {
    ported: "no check where _unrestricted_rendering is False; mail.template: src/models/mail_template_write.ts", models: ["account.move.send.wizard", "calendar.event.archive.or.unlink.wizard", "mail.compose.message", "mail.template"],
    src: "mail/models/mail_render_mixin.py:125",
  },
  // `template_fs` from the install_filename context of a module install
  "create mail.models.template_reset_mixin:TemplateResetMixin": {
    acts: async (env) => "install_filename" in env.context, src: "mail/models/template_reset_mixin.py:28",
  },
  // res.partner's properties definition is forced on create: the port gives it as the default, so a given value refuses
  "create base.models.properties_base_definition_mixin:PropertiesBaseDefinitionMixin": {
    ported: "the default of properties_base_definition_id (src/models/res_partner_write.ts)", when: ["properties_base_definition_id"],
    src: "base/models/properties_base_definition_mixin.py:47",
  },
  "create mail.models.mail_alias_mixin_optional:MailAliasMixinOptional": {
    ported: "src/models/account_journal_create.ts, crm_team.ts, project_project_create.ts", models: ["account.journal", "crm.team", "project.project"],
    src: "mail/models/mail_alias_mixin_optional.py:51",
  },
  // the sanitized name and `_check_unique` (src/models/crm_team.ts mail.alias overrides)
  "create mail.models.mail_alias:MailAlias": { ported: "src/models/crm_team.ts mail.alias create", src: "mail/models/mail_alias.py:246" },
  "write mail.models.mail_alias:MailAlias": { ported: "src/models/crm_team.ts mail.alias write", src: "mail/models/mail_alias.py:264" },
  "unlink mail.models.mail_alias_mixin_optional:MailAliasMixinOptional": {
    ported: "registerAliasMixinUnlink (src/mail/alias_mixin.ts)", models: ["crm.team", "project.project", "account.journal"],
    src: "mail/models/mail_alias_mixin_optional.py:143",
  },

  "create mail.models.mail_template:MailTemplate": { ported: "src/models/mail_template_write.ts (with its refusals)", src: "mail/models/mail_template.py:259" },
  "write mail.models.mail_template:MailTemplate": { ported: "src/models/mail_template_write.ts (with its refusals)", src: "mail/models/mail_template.py:267" },

  // ------------------------------------------------------------------------------------------------------ res.partner
  "create base.models.res_partner:ResPartner": { ported: "src/models/res_partner_write.ts create", src: "base/models/res_partner.py:1028" },
  "write base.models.res_partner:ResPartner": { ported: "src/models/res_partner_write.ts write", src: "base/models/res_partner.py:963" },
  "ondelete base.models.res_partner:ResPartner._unlink_except_user": { ported: "src/models/res_partner_write.ts beforeUnlink", src: "base/models/res_partner.py:1056" },
  "create mail.models.res_partner:ResPartner": { ported: "mail_create_nosubscribe (src/mail/write_hooks.ts)", src: "mail/models/res_partner.py:64" },
  "create account.models.partner:ResPartner": { ported: "erpBeforeCreate (src/models/res_partner_erp_write.ts)", src: "account/models/partner.py:864" },
  "create account_edi_ubl_cii.models.res_partner:ResPartner": { ported: "erpBeforeCreate validateByScheme (src/models/res_partner_erp_write.ts)", src: "account_edi_ubl_cii/models/res_partner.py:186" },
  "create account_peppol.models.res_partner:ResPartner": { ported: "erpAfterCreate (src/models/res_partner_erp_write.ts)", src: "account_peppol/models/res_partner.py:218" },
  // `_clean_routing_endpoint` on write: only with both routing_scheme and routing_endpoint in the values
  "write account_edi_ubl_cii.models.res_partner:ResPartner": {
    when: ["routing_endpoint"], acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["routing_scheme"] && vals["routing_endpoint"]),
    src: "account_edi_ubl_cii/models/res_partner.py:192",
  },
  // the vendor prices of the partner follow its purchase currency
  "write purchase.models.res_partner:ResPartner": { ported: "src/models/res_partner_write.ts write (the vendor pricelists' currency)", src: "purchase/models/res_partner.py:63" },
  // a company change drops the partner from the lots of other companies: refused when such a lot names it
  "write stock.models.res_partner:ResPartner": {
    when: ["company_id"],
    acts: (env, _m, ids, [vals]) => vals?.["company_id"] ? exists(env,
      `SELECT 1 FROM stock_lot l JOIN res_partner_stock_lot_rel r ON r.stock_lot_id = l.id
        WHERE r.res_partner_id = ANY($1::int[]) AND l.company_id IS NOT NULL AND l.company_id != $2 LIMIT 1`, [[...ids], vals["company_id"]]) : Promise.resolve(false),
    src: "stock/models/res_partner.py:31",
  },
  // a new parent moves the partner's journal items to the new commercial partner (and may raise on a VAT mismatch):
  // refused when a re-parented partner has journal items
  // a new parent of a partner with journal items: the VAT check and the journal items' update refuse in the port,
  // the latter after the write so that a recursive hierarchy gives Odoo's ValidationError (rådet runda 13)
  "write account.models.partner:ResPartner": { ported: "src/models/res_partner_write.ts write (with its refusals)", src: "account/models/partner.py:840" },
  "ondelete account.models.partner:ResPartner._unlink_if_partner_in_account_move": {
    ported: "src/models/res_partner_write.ts beforeUnlink", src: "account/models/partner.py:877",
  },
  // -------------------------------------------------------------------------------------------------------- res.users
  // create: src/models/res_users_create.ts, the whole MRO (with its refusals); unlink: src/models/res_users_unlink.ts
  "unlink calendar.models.res_users:ResUsers": { ported: "src/models/res_users_unlink.ts unlink (the calendar memberships)", src: "calendar/models/res_users.py:86" },
  "unlink mail.models.discuss.res_users:ResUsers": {
    ported: "src/models/res_users_unlink.ts nonPublicMembers (src/mail/channel_write.ts unlinkMembers)", src: "mail/models/discuss/res_users.py:31",
  },
  "ondelete auth_signup.models.res_users:ResUsers._ondelete_signup_cancel": { ported: "src/models/res_users_unlink.ts beforeUnlink", src: "auth_signup/models/res_users.py:321" },
  "ondelete base.models.res_users:ResUsers._unlink_except_master_data": { ported: "src/models/res_users_unlink.ts exceptMasterData", src: "base/models/res_users.py:744" },
  ...Object.fromEntries(["project.models.res_users", "digest.models.res_users", "calendar.models.res_users", "auth_signup.models.res_users",
    "mail.models.discuss.res_users", "mail.models.res_users", "base.models.res_users:UsersMultiCompany",
    "base.models.res_users"].map((m) => [`create ${m.includes(":") ? m : `${m}:ResUsers`}`, {
    ported: "src/models/res_users_create.ts create", models: ["res.users"], src: `${m.split(":")[0]!.replace(/\./g, "/")}.py`,
  }])),
  "write base.models.res_users:ResUsers": {
    ported: "src/models/res_users_prefs.ts write (active, delegated fields); src/models/res_users_groups.ts (_check_company, groups); _log_group_changes only logs; the rest in the ORM core",
    // :702-706 a partner of another company follows the user's new company
    when: ["company_id"],
    acts: (env, _m, ids, [vals]) => exists(env,
      `SELECT 1 FROM res_users u JOIN res_partner p ON p.id = u.partner_id WHERE u.id = ANY($1::int[]) AND p.company_id IS NOT NULL
          AND p.company_id IS DISTINCT FROM $2 LIMIT 1`, [[...ids], vals?.["company_id"] || null]),
    src: "base/models/res_users.py:682",
  },
  "write base.models.res_users:UsersMultiCompany": { when: ["company_ids"], src: "base/models/res_users.py:1453" },
  // portal access log message, security notification mails (login, password, email), notification_type bus store
  // group_ids (the portal access log refuses) and notification_type (the Store): src/models/res_users_groups.ts
  "write mail.models.res_users:ResUsers": {
    ported: "src/models/res_users_groups.ts groupsWrite (group_ids, notification_type)", when: ["login", "password", "email"],
    src: "mail/models/res_users.py:209",
  },
  // archiving unsubscribes from the non-public channels (src/models/res_users_prefs.ts archiveUsers, a channel role
  // refuses); new groups subscribe to the channels of those groups (src/models/res_users_groups.ts refuses before the
  // write when a channel would get a member)
  "write mail.models.discuss.res_users:ResUsers": {
    ported: "src/models/res_users_groups.ts groupsWrite (group_ids); src/models/res_users_prefs.ts archiveUsers (active)",
    src: "mail/models/discuss/res_users.py:19",
  },
  "write auth_totp_mail.models.res_users:ResUsers": { when: ["totp_secret"], src: "auth_totp_mail/models/res_users.py:21" },
  // archiving cancels the partner's signup
  "write auth_signup.models.res_users:ResUsers": { ported: "src/models/res_users_prefs.ts archiveUsers", src: "auth_signup/models/res_users.py:316" },
  // ------------------------------------------------------------------------------------------------------- res.groups
  // user_ids (Settings -> Groups): src/models/res_users_groups.ts; any other key refuses (name, the hierarchy, menus,
  // views, access rows: `_apply_group_regular` and the share recomputation follow the hierarchy)
  "write mail.models.discuss.res_groups:ResGroups": {
    ported: "src/models/res_users_groups.ts (a channel that would get a member refuses)", src: "mail/models/discuss/res_groups.py:9",
  },
  "write base.models.res_groups:ResGroups": {
    ported: "src/models/res_users_groups.ts res.groups write (user_ids)",
    acts: async (_env, _m, _ids, [vals]) => Object.keys(vals ?? {}).some((k) => k !== "user_ids"),
    src: "base/models/res_groups.py:223",
  },
  // ------------------------------------------------------------------------------------------------------ res.company
  // create: the whole MRO of the ERP template is ported in one place (src/models/company_create.ts), with its refusals
  ...Object.fromEntries(["sale.models.res_company", "stock.models.res_company", "account.models.company", "payment.models.res_company",
    "partner_autocomplete.models.res_company", "product.models.res_company", "resource.models.res_company", "web.models.models",
    "base.models.res_company"].map((m) => [`create ${m}:ResCompany`, { ported: "src/models/company_create.ts companyCreate", src: `${m.replace(/\./g, "/")}.py` }])),
  "write web.models.models:ResCompany": { ported: "updateAssetStyle (src/models/document_layout.ts)", src: "web/models/models.py:2429" },
  "write base.models.res_company:ResCompany": {
    ported: "src/models/document_layout.ts write (the first country refuses); the address invalidation is a cache",
    // not ported: the hierarchy error, an archived currency activated, branches archived with the company or following the
    // root's delegated fields: refused when the values or the companies reach them
    acts: async (env, _m, ids, [vals]) => "parent_id" in (vals ?? {})
      || (Boolean(vals?.["currency_id"]) && await exists(env, "SELECT 1 FROM res_currency WHERE id = $1 AND NOT active", [vals?.["currency_id"]]))
      || await exists(env, "SELECT 1 FROM res_company WHERE parent_id = ANY($1::int[]) LIMIT 1", [[...ids]]),
    src: "base/models/res_company.py:398",
  },
  "write account.models.company:ResCompany": {
    ported: "validateLocks, refuseAccountCompanyWrites (src/models/account_locks.ts); the fiscal year cache is the port's none",
    // a new currency with journal items raises; changed soft lock dates recreate the active lock exceptions
    acts: async (env, _m, ids, [vals]) =>
      // the UserError with journal items is ported (refuseAccountCompanyWrites); a change without them refuses
      ("currency_id" in (vals ?? {}) && await (async () => {
        const { currencyChanges, existingAccounting } = await import("../models/account_locks");
        for (const id of ids) if (await currencyChanges(env, id, vals?.["currency_id"]) && !(await existingAccounting(env, id))) return true;
        return false;
      })())
      || (["fiscalyear_lock_date", "tax_lock_date", "sale_lock_date", "purchase_lock_date"].some((f) => f in (vals ?? {}))
        && await exists(env, "SELECT 1 FROM account_lock_exception WHERE company_id = ANY($1::int[]) AND active LIMIT 1", [[...ids]])),
    src: "account/models/company.py:883",
  },
  "write sale.models.res_company:ResCompany": { when: ["sale_automatic_invoice"], src: "sale/models/res_company.py:112" },
  // a changed costing method corrects the inventory valuation (cost_method is a non-stored compute: any write refuses)
  "write stock_account.models.res_company:ResCompany": { when: ["cost_method"], src: "stock_account/models/res_company.py:18" },
  "write product.models.res_company:ResCompany": {
    // below account's write in the MRO: when account raises its currency UserError (ported), this one never runs
    when: ["currency_id"], acts: async (env, _m, ids, [vals]) => {
      if (!vals?.["currency_id"]) return false;
      if (!env.reg.models.has("account.move.line")) return true;
      const { currencyChanges, existingAccounting } = await import("../models/account_locks");
      for (const id of ids) if (await currencyChanges(env, id, vals["currency_id"]) && await existingAccounting(env, id)) return false;
      return true;
    }, src: "product/models/res_company.py:53",
  },
  // --------------------------------------------------------------------------------------------------- purchase.order
  // ported; an order created confirmed with lines (state 'purchase' given or a default_state) makes its receipt from
  // inside its own create (the lines' creates, purchase_stock purchase_order_line.py:101): refused
  "create purchase.models.purchase_order:PurchaseOrder": {
    ported: "src/models/purchase_flow.ts create", reads: ["state", "order_line"],
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["state"] === "purchase" && Array.isArray(v["order_line"]) && v["order_line"].length > 0),
    src: "purchase/models/purchase_order.py:454",
  },
  "write purchase_stock.models.purchase_order:PurchaseOrder": {
    ported: "src/models/purchase_flow.ts write (priority of the receipts; order_line on a confirmed order refuses)", src: "purchase_stock/models/purchase_order.py:116",
  },
  "ondelete purchase.models.purchase_order:PurchaseOrder._unlink_if_cancelled": { ported: "src/models/purchase_flow.ts beforeUnlink", src: "purchase/models/purchase_order.py:469" },

  // --------------------------------------------------------------------------------------------------------- crm.lead
  "create crm.models.crm_lead:CrmLead": { ported: "src/models/crm_lead_write.ts create", src: "crm/models/crm_lead.py:728" },
  "create crm_iap_enrich.models.crm_lead:CrmLead": { ported: "enrichTrigger (src/models/crm_lead_write.ts)", src: "crm_iap_enrich/models/crm_lead.py:41" },
  "write crm.models.crm_lead:CrmLead": { ported: "src/models/crm_lead_write.ts write", src: "crm/models/crm_lead.py:760" },
  "unlink crm.models.crm_lead:CrmLead": { ported: "src/models/crm_lead_mail.ts beforeUnlink (the meetings lose their document)", src: "crm/models/crm_lead.py:971" },

  // ------------------------------------------------------------------------------------------------------ project.task
  "create project.models.project_task:ProjectTask": { ported: "src/mail/task_create.ts create (with its refusals)", src: "project/models/project_task.py:1158" },
  "write project.models.project_task:ProjectTask": {
    ported: "src/mail/task_create.ts write (stage_id, state, user_ids) and the key refusals of src/mail/write_hooks.ts beforeWrite", src: "project/models/project_task.py:1274",
  },
  "write project_sms.models.project_task:ProjectTask": { ported: "a stage with an SMS template refuses (src/mail/task_create.ts)", src: "project_sms/models/project_task.py:24" },
  // `_send_sms` of a new task with a customer in a stage with an SMS template
  "create project_sms.models.project_task:ProjectTask": {
    reads: ["partner_id"], acts: async (env, _m, _ids, valsList) => valsList.some((v) => v["partner_id"])
      && exists(env, "SELECT 1 FROM project_task_type WHERE sms_template_id IS NOT NULL LIMIT 1", []),
    src: "project_sms/models/project_task.py:18",
  },
  // a to-do without name, project and parent is named from its description or "Untitled to-do": the given values
  // (`vals.get('project_id')` before super, so a default_project_id does not count). "Untitled to-do" is ported; the
  // name from the description's first line (html2plaintext) is not
  "create project_todo.models.project_task:ProjectTask": {
    ported: "src/mail/task_create.ts createTasks (Untitled to-do)",
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => !v["name"] && !v["project_id"] && !v["parent_id"] && Boolean(v["description"])),
    src: "project_todo/models/project_task.py:11",
  },
  // the subtasks are deleted with their parent, and the recurrence of a recurrence's last task
  "unlink project.models.project_task:ProjectTask": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM project_task WHERE (parent_id = ANY($1::int[]) OR (id = ANY($1::int[]) AND recurrence_id IS NOT NULL)) LIMIT 1", [[...ids]]),
    src: "project/models/project_task.py:1471",
  },

  // ---------------------------------------------------------------------------------------------------- calendar.event
  "create calendar.models.calendar_event:CalendarEvent": { ported: "src/models/calendar_computes.ts create (with its refusals)", src: "calendar/models/calendar_event.py:809" },
  "write calendar.models.calendar_event:CalendarEvent": { ported: "src/models/calendar_computes.ts write (with its refusals)", src: "calendar/models/calendar_event.py:1000" },
  "unlink calendar.models.calendar_event:CalendarEvent": { ported: "src/models/calendar_recurrence.ts unlink (a video call channel refuses)", src: "calendar/models/calendar_event.py:1186" },
  // an event of an opportunity (also through default_opportunity_id) without meeting activity logs the meeting on it
  // (`log_meeting`: not ported); one created on a document gets its meeting activity (src/models/calendar_computes.ts)
  "create crm.models.calendar:CalendarEvent": {
    reads: ["opportunity_id", "meeting_activity_ids", "res_model_id", "res_id"],
    acts: async (env, _m, _ids, valsList) => {
      const { getsMeetingActivity } = await import("../models/calendar_computes");
      for (const v of valsList) if (v["opportunity_id"] && !(await getsMeetingActivity(env, v))) return true;
      return false;
    },
    src: "crm/models/calendar.py:38",
  },
  // ------------------------------------------------------------------------------------------------ sale.order(.line)
  // ported; an order created confirmed with lines (state 'sale' given or a default_state) launches its lines'
  // procurement and service generation from inside its own create (the lines' creates, sale_stock
  // sale_order_line.py:239): refused
  "create sale.models.sale_order:SaleOrder": {
    ported: "src/models/sale_flow.ts create", reads: ["state", "order_line"],
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["state"] === "sale" && Array.isArray(v["order_line"]) && v["order_line"].length > 0),
    src: "sale/models/sale_order.py:1453",
  },
  "ondelete sale.models.sale_order:SaleOrder._unlink_except_draft_or_cancel": { ported: "src/models/sale_flow.ts beforeUnlink", src: "sale/models/sale_order.py:1486" },
  // a project or task the order is created for (context) gets its service line / the order confirmed
  "create sale_project.models.sale_order:SaleOrder": {
    acts: async (env) => Boolean(env.context["create_for_project_id"] || env.context["create_for_task_id"]), src: "sale_project/models/sale_order.py:286",
  },
  // a quotation from an opportunity (is_sale_order) becomes the reinvoiced order of the opportunity's projects
  "create crm_sale_project.models.sale_order:SaleOrder": {
    reads: ["opportunity_id"], acts: async (env, _m, _ids, valsList) => {
      if (!env.context["is_sale_order"]) return false;
      const lead = valsList[0]?.["opportunity_id"];
      return Boolean(lead) && exists(env, "SELECT 1 FROM project_project WHERE lead_id = $1 AND reinvoiced_sale_order_id IS NULL LIMIT 1", [lead]);
    },
    src: "crm_sale_project/models/sale_order.py:7",
  },
  "create sale.models.sale_order_line:SaleOrderLine": { ported: "src/models/sale_flow.ts create", src: "sale/models/sale_order_line.py:1785" },
  "write sale.models.sale_order_line:SaleOrderLine": { ported: "src/models/sale_flow.ts write", src: "sale/models/sale_order_line.py:1801" },
  // a line added to a confirmed order (also through default_order_id, rådet runda 13): procurement (sale_stock, ported),
  // the service's task or project (sale_project) and its purchase (sale_purchase); sale_project also links the
  // context's project
  "create sale_stock.models.sale_order_line:SaleOrderLine": { ported: "src/models/sale_flow.ts create (launchStockRule of the confirmed lines)", src: "sale_stock/models/sale_order_line.py:239" },
  "create sale_purchase.models.sale_order_line:SaleOrderLine": {
    reads: SALE_LINE_READS, acts: (env, _m, _ids, valsList) => confirmedOrder(env, valsList, "subcontract"), src: "sale_purchase/models/sale_order_line.py:42 (:287-298)",
  },
  "create sale_project.models.sale_order_line:SaleOrderLine": {
    reads: SALE_LINE_READS, acts: async (env, _m, _ids, valsList) => Boolean(env.context["link_to_project"]) || confirmedOrder(env, valsList, "project"),
    src: "sale_project/models/sale_order_line.py:118 (:332-344)",
  },
  "write sale_project.models.sale_order_line:SaleOrderLine": { ported: "saleLineWriteChecks refusals (src/models/sale_flow.ts)", src: "sale_project/models/sale_order_line.py:143" },
  "write sale_purchase.models.sale_order_line:SaleOrderLine": { ported: "saleLineWriteChecks refusals (src/models/sale_flow.ts)", src: "sale_purchase/models/sale_order_line.py:51" },
  "write sale_stock.models.sale_order_line:SaleOrderLine": { ported: "src/models/sale_flow.ts write (_action_launch_stock_rule)", src: "sale_stock/models/sale_order_line.py:247" },
  // a confirmed line (not a section/note, not an uninvoiced down payment) cannot be deleted: UserError, refused here
  "ondelete sale.models.sale_order_line:SaleOrderLine._unlink_except_confirmed": {
    acts: (env, _m, ids) => exists(env, `SELECT 1 FROM sale_order_line l WHERE l.id = ANY($1::int[]) AND l.state = 'sale' AND l.display_type IS NULL
        AND (NOT COALESCE(l.is_downpayment, false) OR EXISTS (SELECT 1 FROM sale_order_line_invoice_rel r WHERE r.order_line_id = l.id)) LIMIT 1`, [[...ids]]),
    src: "sale/models/sale_order_line.py:1967",
  },
  // the pricelist of a confirmed order cannot change (UserError)
  "write sale.models.sale_order:SaleOrder": {
    when: ["pricelist_id"], acts: (env, _m, ids) => exists(env, "SELECT 1 FROM sale_order WHERE id = ANY($1::int[]) AND state = 'sale' LIMIT 1", [[...ids]]),
    src: "sale/models/sale_order.py:1497",
  },
  // a cancelled order's lines leave the projects that sold them
  "write sale_project.models.sale_order:SaleOrder": {
    when: ["state"], acts: async (_env, _m, _ids, [vals]) => vals?.["state"] === "cancel", src: "sale_project/models/sale_order.py:302",
  },
  // a lowered quantity on a confirmed order logs on its transfers; a new delivery address goes to the open transfers;
  // the commitment date becomes the deadline of the open customer moves (ported)
  "write sale_stock.models.sale_order:SaleOrder": {
    ported: "src/models/sale_flow.ts write (commitment_date: the deadline of the open customer moves)",
    when: ["order_line", "partner_shipping_id"],
    acts: async (env, _m, ids, [vals]) => {
      if (vals?.["order_line"] && await exists(env, "SELECT 1 FROM sale_order WHERE id = ANY($1::int[]) AND state = 'sale' LIMIT 1", [[...ids]])) {
        // `_log_decrease_ordered_quantity` logs on the upstream documents of the lowered lines' moves
        // (`_log_activity_get_documents(..., 'move_ids', 'UP')`): nothing without moves before them (measured, r10_so_qty)
        const cmds = Array.isArray(vals["order_line"]) ? vals["order_line"] as unknown[] : [];
        for (const c of cmds) {
          if (!Array.isArray(c)) continue;
          if (c[0] === 1 && c[2] && typeof c[2] === "object" && "product_uom_qty" in (c[2] as Record<string, unknown>)) {
            const q = Number((c[2] as Record<string, unknown>)["product_uom_qty"] || 0);
            if (await exists(env, `SELECT 1 FROM sale_order_line l JOIN stock_move m ON m.sale_line_id = l.id JOIN stock_move_move_rel r ON r.move_dest_id = m.id
                WHERE l.id = $1 AND COALESCE(l.product_uom_qty, 0) > $2 LIMIT 1`, [c[1], q])) return true;
            // the overrides of `_get_upstream_documents_and_responsibles` that return documents for a move without moves
            // before it: purchase_requisition_stock's (stock.py:40-46, an agreement line pointing at it), purchase_stock's
            // (stock_move.py:126-133, the purchase lines it created or its purchase line), mrp's (stock_move.py:548-552,
            // its production)
            const moveFields = env.reg.model("stock.move").fields;
            const linked = [
              env.reg.models.has("purchase.requisition.line") && env.reg.model("purchase.requisition.line").fields.has("move_dest_id")
                ? "EXISTS (SELECT 1 FROM purchase_requisition_line x WHERE x.move_dest_id = m.id)" : null,
              moveFields.has("created_purchase_line_ids") ? "EXISTS (SELECT 1 FROM stock_move_created_purchase_line_rel x WHERE x.move_id = m.id)" : null,
              moveFields.has("purchase_line_id") ? "m.purchase_line_id IS NOT NULL" : null,
              moveFields.has("production_id") ? "m.production_id IS NOT NULL" : null,
            ].filter(Boolean);
            if (linked.length && await exists(env, `SELECT 1 FROM sale_order_line l JOIN stock_move m ON m.sale_line_id = l.id
                WHERE l.id = $1 AND COALESCE(l.product_uom_qty, 0) > $2 AND (${linked.join(" OR ")}) LIMIT 1`, [c[1], q])) return true;
          } else if (c[0] === 2 || c[0] === 3 || c[0] === 5 || c[0] === 6) return true;
        }
      }
      return Boolean(vals?.["partner_shipping_id"]) && exists(env, "SELECT 1 FROM stock_picking p JOIN stock_move m ON m.picking_id = p.id JOIN sale_order_line l ON l.id = m.sale_line_id WHERE l.order_id = ANY($1::int[]) AND p.state NOT IN ('done', 'cancel') LIMIT 1", [[...ids]]);
    },
    src: "sale_stock/models/sale_order.py:146",
  },

  // ---------------------------------------------------------------------------------------------------- account.payment
  // create: the outstanding account without accounting (the journal entry values refuse in the port); the context's
  // `force_payment_move` (which overrides a given outstanding account) is not ported
  "create account.models.account_payment:AccountPayment": {
    ported: "src/models/account_payment_register.ts (account.payment create)",
    acts: async (env) => Boolean(env.context["force_payment_move"]),
    src: "account/models/account_payment.py:964",
  },
  // write: a paid/reconciled state without a move generates and posts the journal entry, and a trigger field
  // (`_get_trigger_fields_to_synchronize`, :1139-1143) rewrites the lines of a payment's unposted move
  // (`_synchronize_to_moves`, :1071-1137): neither is ported; other writes are super() (with the port's recomputes)
  "write account.models.account_payment:AccountPayment": {
    ported: "src/models/account_payment_register.ts (account.payment write)",
    acts: async (env, _m, ids, [vals]) => {
      const v = vals ?? {};
      if (["paid", "reconciled"].includes(String(v["state"])) && !v["move_id"]) return true;
      const sync = ["date", "amount", "payment_type", "partner_type", "payment_reference", "currency_id", "partner_id", "destination_account_id", "partner_bank_id", "journal_id"];
      if (!sync.some((k) => k in v)) return false;
      return exists(env, "SELECT 1 FROM account_payment p JOIN account_move m ON m.id = p.move_id WHERE p.id = ANY($1::int[]) AND m.state != 'posted' LIMIT 1", [[...ids]]);
    },
    src: "account/models/account_payment.py:1023",
  },
  // unlink: the payment's journal entry is reset to draft and deleted, and the reconciled invoices' payment state is
  // recomputed: not ported, so a payment with a journal entry refuses
  "unlink account.models.account_payment:AccountPayment": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM account_payment WHERE id = ANY($1::int[]) AND move_id IS NOT NULL LIMIT 1", [[...ids]]),
    src: "account/models/account_payment.py:1033",
  },

  // ------------------------------------------------------------------------------------------------- account.move(.line)
  "create account.models.account_move:AccountMove": { ported: "src/models/account_move_create.ts (with its refusals)", src: "account/models/account_move.py" },
  "write account.models.account_move:AccountMove": { ported: "src/models/account_entries.ts, account_hash.ts, account_move_create.ts", src: "account/models/account_move.py" },
  "unlink account.models.account_move:AccountMove": { ported: "src/models/account_integrity.ts unlink", src: "account/models/account_move.py:4200" },
  "unlink sale.models.account_move:AccountMove": { ported: "down payment lines refuse (src/models/account_integrity.ts)", src: "sale/models/account_move.py:36" },
  "ondelete account.models.account_move:AccountMove._unlink_forbid_parts_of_chain": { ported: "src/models/account_integrity.ts", src: "account/models/account_move.py" },
  "ondelete account.models.account_move:AccountMove._unlink_account_audit_trail_except_once_post": { ported: "src/models/account_integrity.ts", src: "account/models/account_move.py" },
  "create account.models.account_move_line:AccountMoveLine": { ported: "src/models/account_integrity.ts create", src: "account/models/account_move_line.py" },
  "write account.models.account_move_line:AccountMoveLine": { ported: "src/models/account_integrity.ts write", src: "account/models/account_move_line.py" },
  "unlink account.models.account_move_line:AccountMoveLine": { ported: "src/models/account_integrity.ts", src: "account/models/account_move_line.py" },
  "ondelete account.models.account_move_line:AccountMoveLine._except_hashed_entry_lines": { ported: "src/models/account_integrity.ts beforeUnlink", src: "account/models/account_move_line.py" },
  "ondelete account.models.account_move_line:AccountMoveLine._prevent_automatic_line_deletion": { ported: "src/models/account_integrity.ts beforeUnlink", src: "account/models/account_move_line.py" },
  "ondelete account.models.account_move_line:AccountMoveLine._unlink_except_posted": { ported: "src/models/account_integrity.ts beforeUnlink", src: "account/models/account_move_line.py" },
  // "This vendor bill has been created from / modified from:" when lines of purchase orders come in through the values
  // (the port posts it in its own bill creation, src/models/purchase_bill.ts)
  "create purchase.models.account_invoice:AccountMove": {
    reads: ["reversed_entry_id"], acts: async (_env, _m, _ids, valsList) => valsList.some((v) => !v["reversed_entry_id"]
      && [...commandValues([v], "invoice_line_ids"), ...commandValues([v], "line_ids")].some((l) => l["purchase_line_id"])),
    src: "purchase/models/account_invoice.py:259",
  },
  "write purchase.models.account_invoice:AccountMove": {
    when: ["invoice_line_ids", "line_ids", "purchase_vendor_bill_id", "purchase_id"],
    acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["purchase_vendor_bill_id"] || vals?.["purchase_id"])
      || [...commandValues(vals ? [vals] : [], "invoice_line_ids"), ...commandValues(vals ? [vals] : [], "line_ids")].some((l) => l["purchase_line_id"]),
    src: "purchase/models/account_invoice.py:274",
  },
  // ---------------------------------------------------------------------------------------------- purchase.order.line
  // ported, with the "Extra line with" note of a line added to a confirmed order (round 14)
  "create purchase.models.purchase_order_line:PurchaseOrderLine": {
    ported: "src/models/purchase_flow.ts create", src: "purchase/models/purchase_order_line.py:413",
  },
  // a line added to a confirmed order makes or updates its receipt and its promised date (round 14: purchase_flow.ts
  // create through purchase_receipt.ts createOrUpdatePicking, with its refusals)
  "create purchase_stock.models.purchase_order_line:PurchaseOrderLine": {
    ported: "src/models/purchase_flow.ts create (createOrUpdatePicking, _set_date_promised)", src: "purchase_stock/models/purchase_order_line.py:101",
  },
  // `_recompute_recordset(['analytic_distribution'])` computes what is pending, which the create has done already
  "create project_purchase.models.purchase_order_line:PurchaseOrderLine": { ported: "no pending compute after the port's create", src: "project_purchase/models/purchase_order_line.py:31" },
  "write purchase_stock.models.purchase_order_line:PurchaseOrderLine": { ported: "purchaseLineWriteMoves (src/models/purchase_receipt.ts), with its refusals", src: "purchase_stock/models/purchase_order_line.py:110" },
  // ported (the price/quantity note, src/models/purchase_flow.ts logLinePriceChange); not: the type change error and
  // the note of a received quantity written on a confirmed order
  "write purchase.models.purchase_order_line:PurchaseOrderLine": {
    ported: "logLinePriceChange (src/models/purchase_flow.ts)", when: ["display_type", "qty_received"],
    acts: async (env, _m, ids, [vals]) => ("display_type" in (vals ?? {}) && await exists(env, "SELECT 1 FROM purchase_order_line WHERE id = ANY($1::int[]) AND display_type IS DISTINCT FROM $2 LIMIT 1", [[...ids], vals?.["display_type"] || null]))
      || ("qty_received" in (vals ?? {}) && await exists(env, "SELECT 1 FROM purchase_order_line l JOIN purchase_order o ON o.id = l.order_id WHERE l.id = ANY($1::int[]) AND o.state = 'purchase' LIMIT 1", [[...ids]])),
    src: "purchase/models/purchase_order_line.py:433",
  },

  // ------------------------------------------------------------------------------------------------------- stock.quant
  "create stock.models.stock_quant:StockQuant": { ported: "src/models/stock_inventory.ts create (with its refusals)", src: "stock/models/stock_quant.py:284" },
  // in the inventory mode the forbidden fields raise (or are ignored on an inventory loss)
  "write stock.models.stock_quant:StockQuant": { when: ["product_id", "location_id", "lot_id", "package_id", "owner_id"], src: "stock/models/stock_quant.py:384" },

  // ------------------------------------------------------------------------------------------------ base.document.layout
  "create account.wizard.base_document_layout:BaseDocumentLayout": { ported: "src/models/document_layout.ts create", src: "account/wizard/base_document_layout.py:200" },
  "write account.wizard.base_document_layout:BaseDocumentLayout": { ported: "src/models/document_layout.ts write", src: "account/wizard/base_document_layout.py:228" },
  // ---------------------------------------------------------------------------------------------------------- misc
  "create base.models.res_country:ResCountryGroup": { ported: "src/models/crm_calendar.ts create (_sanitize_vals)", src: "base/models/res_country.py:216" },
  "write base.models.res_country:ResCountryGroup": { ported: "src/models/crm_calendar.ts write (_sanitize_vals)", src: "base/models/res_country.py:220" },
  "write calendar.models.calendar_calendar:CalendarCalendar": { ported: "src/models/calendar_computes.ts write (somebody else than the owner refuses)", src: "calendar/models/calendar_calendar.py:59" },
  // the events (and recurrences) of a deleted calendar are deleted through the ORM first
  "unlink calendar.models.calendar_calendar:CalendarCalendar": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM calendar_event WHERE calendar_id = ANY($1::int[]) LIMIT 1", [[...ids]]), src: "calendar/models/calendar_calendar.py:135",
  },
  // the calendars left without members follow their last memberships
  "write calendar.models.calendar_user:CalendarUser": { ported: "src/models/res_users_unlink.ts calendar.user write (the writeable fields)", src: "calendar/models/calendar_user.py:35" },
  "unlink calendar.models.calendar_user:CalendarUser": { ported: "src/models/res_users_unlink.ts unlinkCalendarUsers", src: "calendar/models/calendar_user.py:42" },
  "ondelete calendar.models.calendar_calendar:CalendarCalendar._unlink_except_primary": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM calendar_user WHERE calendar_id = ANY($1::int[]) AND is_primary LIMIT 1", [[...ids]]), src: "calendar/models/calendar_calendar.py:126",
  },

  // mono-membership mode: the users' memberships in other teams are archived (src/models/crm_team.ts)
  "create sales_team.models.crm_team_member:CrmTeamMember": { ported: "src/models/crm_team.ts create (synchronizeMemberships)", src: "sales_team/models/crm_team_member.py:153" },
  // crm.team: the alias (src/models/crm_team.ts createWithAlias) and the members' inverse are ported
  "create sales_team.models.crm_team:CrmTeam": {
    ported: "mail_create_nosubscribe (src/mail/write_hooks.ts createContext)",
    // the members of a new team become its favorites (favorite_user_ids)
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => linkedIds(v["member_ids"]).length > 0 || linkedIds(v["crm_team_member_ids"]).length > 0),
    src: "sales_team/models/crm_team.py:224",
  },
  // member_ids: the favorites (src/models/crm_team.ts write); a new company re-checks the memberships (not ported)
  "write sales_team.models.crm_team:CrmTeam": {
    ported: "src/models/crm_team.ts write (_add_members_to_favorites)",
    when: ["company_id"], acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["company_id"]),
    src: "sales_team/models/crm_team.py:230",
  },
  // activating memberships archives the users' others in mono-membership mode (src/models/crm_team.ts)
  "write sales_team.models.crm_team_member:CrmTeamMember": { ported: "src/models/crm_team.ts crm.team.member write (synchronizeMemberships)", src: "sales_team/models/crm_team_member.py:173" },
  "write crm.models.crm_team:CrmTeam": { when: ["use_leads", "use_opportunities"], src: "crm/models/crm_team.py:120" },
  // the team's lead scoring frequencies are merged into the "no team" ones
  "unlink crm.models.crm_team:CrmTeam": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM crm_lead_scoring_frequency WHERE team_id = ANY($1::int[]) AND (won_count > 0.1 OR lost_count > 0.1) LIMIT 1", [[...ids]]),
    src: "crm/models/crm_team.py:131",
  },
  "ondelete sale.models.crm_team:CrmTeam._unlink_except_used_for_sales": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM sale_order WHERE team_id = ANY($1::int[]) AND state != 'cancel' GROUP BY team_id HAVING count(*) >= 5", [[...ids]]),
    src: "sale/models/crm_team.py:35",
  },
  "ondelete sales_team.models.crm_team:CrmTeam._unlink_except_default": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM ir_model_data WHERE model = 'crm.team' AND module = 'sales_team' AND name IN ('salesteam_website_sales', 'pos_sales_team') AND res_id = ANY($1::int[])", [[...ids]]),
    src: "sales_team/models/crm_team.py:240",
  },

  // stock.lot
  "create stock_account.models.stock_lot:StockLot": { ported: "src/models/stock_new.ts create (standard_price of a lot-valuated product)", src: "stock_account/models/stock_lot.py:49" },
  // `_check_create` of the active picking's operation type; mail_create_nosubscribe is the hooks' createContext
  "create stock.models.stock_lot:StockLot": { acts: async (env) => Boolean(env.context["active_picking_id"]), src: "stock/models/stock_lot.py:192" },
  "write stock.models.stock_lot:StockLot": { when: ["company_id", "product_id"], src: "stock/models/stock_lot.py:198" },
  "write stock_account.models.stock_lot:StockLot": {
    when: ["standard_price"], acts: async (env) => !env.context["disable_auto_revaluation"], src: "stock_account/models/stock_lot.py:58",
  },

  // account.analytic.line
  "create account.models.account_analytic_line:AccountAnalyticLine": {
    reads: ["move_line_id"], acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["move_line_id"]), src: "account/models/account_analytic_line.py:166",
  },
  "write account.models.account_analytic_line:AccountAnalyticLine": {
    ported: "src/models/analytic_line.ts write (lines of journal items refuse)",
    acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["move_line_id"]), src: "account/models/account_analytic_line.py:172",
  },
  "unlink account.models.account_analytic_line:AccountAnalyticLine": { ported: "lines of journal items refuse (src/models/analytic_line.ts)", src: "account/models/account_analytic_line.py:181" },
  "write analytic.models.analytic_line:AccountAnalyticLine": {
    // `_check_can_write`: lines of a journal item (or with one given) refuse in the account override above
    ported: "src/models/analytic_line.ts", src: "analytic/models/analytic_line.py:240",
  },
  "create sale.models.account_analytic_line:AccountAnalyticLine": { acts: async (env) => Boolean(env.context["from_services_and_material"]), src: "sale/models/account_analytic_line.py:48" },
  "write sale.models.account_analytic_line:AccountAnalyticLine": { acts: async (env) => Boolean(env.context["from_services_and_material"]), src: "sale/models/account_analytic_line.py:61" },
  "ondelete sale.models.account_analytic_line:AccountAnalyticLine._unlink_so_lines_except_invoiced": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM account_analytic_line WHERE id = ANY($1::int[]) AND (so_line IS NOT NULL OR reinvoice_move_id IS NOT NULL) LIMIT 1", [[...ids]]),
    src: "sale/models/account_analytic_line.py:113",
  },

  // mail.activity.type: the master types of `_get_model_info_by_xmlid` (mail_activity_type.py:163-176, through the
  // dispatch: a module's types too) keep their model (write :106-125 raises) and those with `unlink: False` cannot be
  // deleted (ondelete :127-138); archiving the to-do type raises in `action_archive` (:140-143, the generic archive here
  // writes `active`); deleting a type moves its activities to the to-do type (unlink :145-151). Where they would act,
  // the port refuses
  "write mail.models.mail_activity_type:MailActivityType": {
    acts: async (env, _m, ids, valsList) => {
      const vals = valsList[0] ?? {};
      if ("res_model" in vals) {
        // :111-118 `(vals['res_model'] or False) != (model or False) and activity_type in self`
        for (const [x, info] of await modelInfoByXmlid(env)) {
          const id = (await xmlidIds(env, [x]))[0];
          if (id !== undefined && ids.includes(id) && (vals["res_model"] || false) !== (info.res_model || false)) return true;
        }
      }
      const todo = (await xmlidIds(env, ["mail.mail_activity_data_todo"]))[0];
      return "active" in vals && !vals["active"] && todo !== undefined && ids.includes(todo);
    },
    src: "mail/models/mail_activity_type.py:106",
  },
  "ondelete mail.models.mail_activity_type:MailActivityType._unlink_except_todo": {
    acts: async (env, _m, ids) => (await xmlidIds(env, (await modelInfoByXmlid(env)).filter(([, info]) => info.unlink === false).map(([x]) => x)))
      .some((id) => ids.includes(id)),
    src: "mail/models/mail_activity_type.py:127",
  },
  "unlink mail.models.mail_activity_type:MailActivityType": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM mail_activity WHERE activity_type_id = ANY($1::int[]) LIMIT 1", [[...ids]]),
    src: "mail/models/mail_activity_type.py:145",
  },
  // discuss
  "create mail.models.discuss.discuss_channel:DiscussChannel": {
    ported: "src/mail/channel_write.ts create (explicit members, group_ids, install mode and the public user refuse)", src: "mail/models/discuss/discuss_channel.py:522",
  },
  "ondelete mail.models.discuss.discuss_channel:DiscussChannel._unlink_channel": { ported: "src/mail/channel_write.ts beforeUnlink", src: "mail/models/discuss/discuss_channel.py:590" },
  "write mail.models.discuss.discuss_channel:DiscussChannel": { ported: "channelBeforeWrite (src/mail/channel_write.ts, with its refusals)", src: "mail/models/discuss/discuss_channel.py:596" },
  "write mail.models.discuss.bus_sync_mixin:BusSyncMixin": {
    ported: "channelBeforeWrite (src/mail/channel_write.ts) for discuss.channel; a discuss.category without channels has no bus target",
    acts: async (env, model, ids) => model === "discuss.category"
      ? exists(env, "SELECT 1 FROM discuss_channel WHERE discuss_category_id = ANY($1::int[]) LIMIT 1", [[...ids]]) : model !== "discuss.channel",
    src: "mail/models/discuss/bus_sync_mixin.py:26",
  },
  "ondelete mail.models.discuss.discuss_category:DiscussCategory._unlink_sync_to_channel": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM discuss_channel WHERE discuss_category_id = ANY($1::int[]) LIMIT 1", [[...ids]]),
    src: "mail/models/discuss/discuss_category.py:29",
  },
  // --------------------------------------------------------------------------------------------- product.template
  "create product.models.product_template:ProductTemplate": { ported: "src/models/inventory_flow.ts create (variants, related fields, barcode check)", src: "product/models/product_template.py:812" },
  "create account.models.product:ProductTemplate": { ported: "forceDefaultTaxes (src/models/inventory_flow.ts)", src: "account/models/product.py:295" },
  "create sale_purchase.models.product_template:ProductTemplate": { ported: "checkSubcontractVendors (src/models/inventory_flow.ts)", src: "sale_purchase/models/product_template.py:29" },
  // a positive initial quantity of a storable product without tracking becomes the variant's quantity on hand
  "create stock.models.product:ProductTemplate": {
    ported: "dropZeroQuantity (src/models/inventory_flow.ts)", acts: async (_env, _m, _ids, valsList) => valsList.some((v) => Number(v["qty_available"] || 0) > 0),
    src: "stock/models/product.py:1091",
  },
  "write sale_purchase.models.product_template:ProductTemplate": { ported: "checkSubcontractVendors (src/models/inventory_flow.ts)", src: "sale_purchase/models/product_template.py:36" },
  // ported (writeTemplate, src/models/product_template_edit.ts): the cost, the service policy, store_by, a new unit on
  // the variants' stock moves and lines, the variants of an unarchived template, archived variants, the barcode check;
  // not: variants made from attribute lines, combo choices dropped by a type change, the company's barcode check
  "write product.models.product_template:ProductTemplate": {
    ported: "writeTemplate (src/models/inventory_flow.ts)", when: ["attribute_line_ids", "type", "company_id"],
    acts: async (env, _m, ids, [vals]) => {
      const v = vals ?? {};
      if ("attribute_line_ids" in v) return true;
      if ("type" in v && v["type"] !== "combo" && await exists(env, "SELECT 1 FROM product_combo_product_template_rel WHERE product_template_id = ANY($1::int[]) LIMIT 1", [[...ids]])) return true;
      return "company_id" in v && await exists(env, "SELECT 1 FROM product_product WHERE product_tmpl_id = ANY($1::int[]) AND barcode IS NOT NULL AND barcode != '' LIMIT 1", [[...ids]]);
    },
    src: "product/models/product_template.py:836",
  },
  "write account.models.product:ProductTemplate": { when: ["type"], acts: async (_env, _m, _ids, [vals]) => vals?.["type"] === "combo", src: "account/models/product.py:307" },
  // ported: Track Inventory turned on (cleanReservations, resetInventory in src/models/product_template_edit.ts, with
  // their refusals); not: a new company with stock moves or quants elsewhere
  "write stock.models.product:ProductTemplate": {
    ported: "writeTemplate (src/models/inventory_flow.ts)", when: ["company_id"],
    acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["company_id"]),
    src: "stock/models/product.py:1105",
  },
  // ported: a category of another costing method (costMethodChanges, updateStandardPrice: a standard cost); not: lot valuation
  "write stock_account.models.product:ProductTemplate": { ported: "writeTemplate (src/models/inventory_flow.ts)", when: ["lot_valuated"], src: "stock_account/models/product.py:36" },
  "write sale_project.models.product_template:ProductTemplate": { ported: "writeTemplate (src/models/inventory_flow.ts)", src: "sale_project/models/product_template.py:139" },

  // ---------------------------------------------------------------------------------------------- product.product
  "create product.models.product_product:ProductProduct": {
    ported: "src/models/inventory_flow.ts create (create_product_product)", acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["barcode"]),
    src: "product/models/product_product.py:884",
  },
  "unlink product.models.product_product:ProductProduct": { ported: "src/models/inventory_flow.ts unlink (with its refusals)", src: "product/models/product_product.py:925" },
  "create stock_account.models.product:ProductProduct": { ported: "initialCostRows (src/models/inventory_flow.ts)", src: "stock_account/models/product.py:191" },
  "write product.models.product_product:ProductProduct": { ported: "checkVariantBarcodes (src/models/product_template_edit.ts)", src: "product/models/product_product.py:895" },
  "write stock.models.product:ProductProduct": { ported: "orderpointsFollow (src/models/product_template_edit.ts)", src: "stock/models/product.py:697" },
  "write stock_account.models.product:ProductProduct": {
    ported: "src/models/inventory_flow.ts write (the cost row, changeStandardPrice in src/models/stock_valuation.ts)", when: ["lot_valuated"],
    src: "stock_account/models/product.py:197",
  },
  "write sale_project.models.product_product:ProductProduct": {
    when: ["type"], acts: async (_env, _m, _ids, [vals]) => vals?.["type"] !== "service", src: "sale_project/models/product_product.py:25",
  },
  "write stock_account.models.product:ProductCategory": { when: ["property_cost_method"], src: "stock_account/models/product.py:765" },
  // ------------------------------------------------------------------------------------- journals, taxes, access, views
  "create account.models.account_journal:AccountJournal": { ported: "src/models/account_journal_create.ts create", src: "account/models/account_journal.py:1049" },
  // ported (journalWrite): the readable alias name, the hash restriction (checkJournalHashWrite), the payment method
  // lines, alias and account currency after a type or currency change; not: the bank account's company and partner, a
  // bank account number
  "write account.models.account_journal:AccountJournal": {
    ported: "journalWrite (src/models/account_journal_create.ts)", when: ["company_id", "bank_account_id", "bank_account_number"],
    src: "account/models/account_journal.py:775",
  },
  // the payment method lines unlinked first; the bank accounts only these journals use refuse (their archive)
  "unlink account.models.account_journal:AccountJournal": { ported: "src/models/account_journal_create.ts unlink", src: "account/models/account_journal.py:734" },
  "ondelete account_payment.models.account_journal:AccountJournal._unlink_except_linked_to_payment_provider": {
    ported: "exceptLinkedToPaymentProvider (src/models/account_journal_create.ts)", src: "account_payment/models/account_journal.py:10",
  },
  "create account.models.account_tax:AccountTax": { ported: "src/models/account_move_create.ts create (context, sanitizeTax)", src: "account/models/account_tax.py:613" },
  // the zip range's padding; the foreign VAT's inverse and the two constraints are ported beside them
  "create account.models.partner:AccountFiscalPosition": { ported: "src/models/account_journal_create.ts (account.fiscal.position create)", src: "account/models/partner.py:203" },
  "write account.models.partner:AccountFiscalPosition": { ported: "src/models/account_journal_create.ts (account.fiscal.position write)", src: "account/models/partner.py:212" },
  "write account.models.account_tax:AccountTax": { ported: "src/models/account_move_create.ts write (sanitizeTax)", src: "account/models/account_tax.py:626" },
  // `_recompute_all` is the port's flush; `_clear_caches` is the signaling of src/orm/signaling.ts (ir_access is watched)
  // ir_actions.py:695-712: the first history entry of a code action (a child action, `parent_id`, refuses there)
  "create base.models.ir_actions:IrActionsServer": { ported: "src/models/ir_actions_server.ts create", src: "base/models/ir_actions.py:695" },
  // a new `code` adds a history entry (`ir_actions_server.ts` write)
  "write base.models.ir_actions:IrActionsServer": { ported: "src/models/ir_actions_server.ts write (code history)", src: "base/models/ir_actions.py:714-717" },
  // B4: a custom field; what the port does not do (other types, a custom model, ...) refuses in the override itself
  "create base.models.ir_model:IrModelFields": { ported: "src/models/ir_model_fields_create.ts", src: "base/models/ir_model.py:1162-1214" },
  "create base.models.ir_model:IrModel": { ported: "src/models/ir_model_create.ts", src: "base/models/ir_model.py:455-470" },
  "write base.models.ir_model:IrModelFields": { ported: "src/models/ir_model_fields_create.ts write", src: "base/models/ir_model.py:1220-1305" },
  "unlink base.models.ir_model:IrModelFields": { ported: "src/models/ir_model_fields_create.ts unlink (a module uninstall)", src: "base/models/ir_model.py:1116-1157" },
  "create base.models.ir_model:IrModelFieldsSelection": { ported: "src/models/ir_model_fields_create.ts (options of a new manual field)", src: "base/models/ir_model.py:1886-1912" },
  "create base.models.ir_access:IrAccess": {
    ported: "signaling (src/orm/signaling.ts)",
    // the operation letters from the for_* flags when no operation is given
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => !("operation" in v) && ["for_create", "for_read", "for_write", "for_unlink"].some((f) => v[f])),
    src: "base/models/ir_access.py:217",
  },
  "write base.models.ir_access:IrAccess": { ported: "signaling (src/orm/signaling.ts)", src: "base/models/ir_access.py:236" },
  "unlink base.models.ir_access:IrAccess": { ported: "signaling (src/orm/signaling.ts)", src: "base/models/ir_access.py:244" },
  "create base.models.ir_ui_view:IrUiView": { ported: "src/modules/ir_ui_view.ts create", src: "base/models/ir_ui_view.py" },
  "write base.models.ir_ui_view:IrUiView": { ported: "src/modules/ir_ui_view.ts write", src: "base/models/ir_ui_view.py" },
  "create base.models.res_currency:ResCurrency": { ported: "toggleMultiCurrency (src/models/invoicing_computes.ts)", src: "base/models/res_currency.py:93" },
  "write base.models.res_currency:ResCurrency": { ported: "toggleMultiCurrency (src/models/invoicing_computes.ts)", src: "base/models/res_currency.py:104" },
  "unlink base.models.res_currency:ResCurrency": { ported: "toggleMultiCurrency (src/models/invoicing_computes.ts)", src: "base/models/res_currency.py:99" },
  // fewer decimals on a currency with journal items raise; an archived currency archives its pricelists
  "write account.models.res_currency:ResCurrency": { when: ["rounding"], src: "account/models/res_currency.py:28" },
  "write product.models.res_currency:ResCurrency": {
    when: ["active"], acts: async (env, _m, ids, [vals]) => !vals?.["active"] && exists(env, "SELECT 1 FROM product_pricelist WHERE currency_id = ANY($1::int[]) AND active LIMIT 1", [[...ids]]),
    src: "product/models/res_currency.py:18",
  },
  "create base.models.res_currency:ResCurrencyRate": { ported: "sanitizeRate (src/models/invoicing_computes.ts); the rate cache is the port's none", src: "base/models/res_currency.py:454" },
  "write base.models.res_currency:ResCurrencyRate": { ported: "sanitizeRate (src/models/invoicing_computes.ts)", src: "base/models/res_currency.py:459" },
  "create account.models.res_currency:ResCurrencyRate": { ported: "an in-process cache (res_currency_to_company_rates)", src: "account/models/res_currency.py:136" },
  "write account.models.res_currency:ResCurrencyRate": { ported: "an in-process cache (res_currency_to_company_rates)", src: "account/models/res_currency.py:141" },

  // ---------------------------------------------------------------------------------------------- project.project
  "create project.models.project_project:ProjectProject": { ported: "src/models/project_project_create.ts create", src: "project/models/project_project.py:620" },
  "write project.models.project_project:ProjectProject": { ported: "src/models/project_project_create.ts write (with its refusals)", src: "project/models/project_project.py:660" },
  // project.project, crm.team and account.journal: aliasMixinWrite (src/mail/alias_mixin.ts) in their write overrides;
  // not ported: the alias domain synchronisation after a company change (:128-133)
  "write mail.models.mail_alias_mixin_optional:MailAliasMixinOptional": {
    ported: "aliasMixinWrite (src/mail/alias_mixin.ts) of src/models/project_project_create.ts, crm_team.ts and account_journal_create.ts writes",
    models: ["project.project", "crm.team", "account.journal"],
    when: ["alias_name", "alias_domain_id", "alias_contact", "alias_defaults", "alias_bounced_content", "company_id"],
    acts: async (_env, _model, _ids, [vals]) => "company_id" in (vals ?? {}),
    src: "mail/models/mail_alias_mixin_optional.py:108",
  },
  // a new project of a sale order (or its reinvoiced one) becomes that order's project
  "create sale_project.models.project_project:ProjectProject": {
    reads: ["sale_order_id", "reinvoiced_sale_order_id", "sale_line_id"],
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["sale_order_id"] || v["reinvoiced_sale_order_id"] || v["sale_line_id"]),
    src: "sale_project/models/project_project.py:230",
  },
  // `_send_sms` of the project stage's SMS template to the customer
  "create project_sms.models.project_project:ProjectProject": {
    reads: ["partner_id"], acts: async (env, _m, _ids, valsList) => valsList.some((v) => v["partner_id"]) && exists(env, "SELECT 1 FROM project_project_stage WHERE sms_template_id IS NOT NULL LIMIT 1", []),
    src: "project_sms/models/project_project.py:18",
  },
  "write project_sms.models.project_project:ProjectProject": {
    when: ["stage_id"], acts: (env) => exists(env, "SELECT 1 FROM project_project_stage WHERE sms_template_id IS NOT NULL LIMIT 1", []),
    src: "project_sms/models/project_project.py:24",
  },
  "write sale_project.models.project_project:ProjectProject": {
    when: ["allow_billable"], acts: async (_env, _m, _ids, [vals]) => vals?.["allow_billable"] === false, src: "sale_project/models/project_project.py:240",
  },
  // the embedded action settings and the tasks are deleted with the project (src/models/project_project_create.ts
  // unlink, which refuses an empty analytic account to delete and subtasks outside or recurrences)
  "unlink project.models.project_project:ProjectProject": { ported: "src/models/project_project_create.ts unlink (with its refusals)", src: "project/models/project_project.py:799" },
  // the project feature groups follow the last project using them
  "ondelete project.models.project_project:ProjectProject._check_project_group_at_removal": {
    ported: "src/models/project_project_create.ts beforeUnlink (checkProjectGroup)", src: "project/models/project_project.py:815",
  },

  // -------------------------------------------------------------------------------------------------- stock.picking
  "create stock.models.stock_picking:StockPicking": {
    ported: "src/models/stock_new.ts create (the name; scheduled_date through its inverse)",
    // the batch, and `_autoconfirm_picking` of moves created with a quantity
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["batch_id"]) || commandValues(valsList, "move_ids").some((m) => Number(m["quantity"] || 0) > 0),
    src: "stock/models/stock_picking.py:654",
  },
  "write stock.models.stock_picking:StockPicking": {
    ported: "src/models/stock_new.ts write (the operation type, the transfer date, the moves' locations and contact)",
    when: ["batch_id", "signature", "move_ids"],
    acts: async (env, _m, ids, [vals]) => {
      const v = vals ?? {};
      if (v["batch_id"] || v["signature"]) return true;
      if (!v["move_ids"]) return false;
      // `_autoconfirm_picking` (:1368-1381): moves added to a confirmed transfer (`additional`), and the draft moves
      // with a quantity after the write
      const cmds = Array.isArray(v["move_ids"]) ? v["move_ids"] as unknown[] : [];
      const created = cmds.filter((c): c is [number, unknown, Record<string, unknown>] => Array.isArray(c) && c[0] === 0);
      if (created.length && await exists(env, "SELECT 1 FROM stock_picking WHERE id = ANY($1::int[]) AND state NOT IN ('draft', 'done', 'cancel') LIMIT 1", [[...ids]])) return true;
      if (created.some((c) => Number(c[2]?.["quantity"] || 0) > 0)) return true;
      for (const c of cmds) {
        if (Array.isArray(c) && c[0] === 1 && c[2] && typeof c[2] === "object" && Number((c[2] as Record<string, unknown>)["quantity"] || 0) > 0
          && await exists(env, "SELECT 1 FROM stock_move WHERE id = $1 AND state = 'draft'", [c[1]])) return true;
      }
      return exists(env, "SELECT 1 FROM stock_move WHERE picking_id = ANY($1::int[]) AND state = 'draft' AND quantity > 0 LIMIT 1", [[...ids]]);
    },
    src: "stock/models/stock_picking.py:683",
  },
  "unlink stock.models.stock_picking:StockPicking": { ported: "src/models/stock_new.ts beforeUnlink (with its refusals)", src: "stock/models/stock_picking.py:724" },
  // ------------------------------------------------------------------------------------------- product attributes
  // an attribute used on products cannot be deleted (UserError): refused here; write (variant mode, values) refuses
  "ondelete product.models.product_attribute:ProductAttribute._unlink_except_used_on_product": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM product_template_attribute_line WHERE attribute_id = ANY($1::int[]) LIMIT 1", [[...ids]]),
    src: "product/models/product_attribute.py:134",
  },
  // ------------------------------------------------------------------------------------------------------ stock.move
  "create stock.models.stock_move:StockMove": { ported: "src/models/stock_new.ts create", src: "stock/models/stock_move.py:840" },
  "write stock.models.stock_move:StockMove": { ported: "src/models/stock_new.ts write (demand, deadlines, a new source's lines, warehouse, orderpoints, with its refusals)", src: "stock/models/stock_move.py:872" },
  "unlink stock.models.stock_move:StockMove": { ported: "src/models/stock_push.ts (stock.move unlink: its lines, then the orderpoints)", src: "stock/models/stock_move.py:2463" },
  // a move linked to another operation that is not draft or cancelled cannot be deleted (UserError)
  "ondelete stock.models.stock_move:StockMove._unlink_if_draft_or_cancel": { ported: "src/models/stock_push.ts (stock.move beforeUnlink)", src: "stock/models/stock_move.py:2458" },
  // a product change of a move of a confirmed order line detaches the line
  "write sale_stock.models.stock:StockMove": { when: ["product_id"], src: "sale_stock/models/stock.py:188" },
  // a new date (not done) is the purchase line's planned date
  "write purchase_stock.models.stock_move:StockMove": {
    when: ["date"], acts: async (_env, _m, _ids, [vals]) => Boolean(vals?.["date"]) && vals?.["state"] !== "done", src: "purchase_stock/models/stock_move.py:67",
  },
  // a new date of a valued move replays the valuation; a new value goes to the COGS lines
  "write stock_account.models.stock_move:StockMove": { when: ["date", "value"], src: "stock_account/models/stock_move.py:181" },
  "create project.models.project_update:ProjectUpdate": { ported: "src/models/project_project_create.ts create", src: "project/models/project_update.py:88" },
  // ------------------------------------------------------------------------------- configuration records (opus12_writes)
  // a stage marked (un)won sets its leads' probabilities (100, or the PLS recomputation)
  "write crm.models.crm_stage:CrmStage": {
    when: ["is_won"], acts: (env, _m, ids) => exists(env, "SELECT 1 FROM crm_lead WHERE stage_id = ANY($1::int[]) LIMIT 1", [[...ids]]),
    src: "crm/models/crm_stage.py:70",
  },
  // an archived stage archives its tasks; the rating switch (rating subtypes) refuses in the port
  "write project.models.project_task_type:ProjectTaskType": {
    ported: "src/models/config_overrides.ts (project.task.type write)", src: "project/models/project_task_type.py:109",
  },
  // the variant mode of an attribute used on products cannot change (UserError); a new sequence only invalidates caches
  "write product.models.product_attribute:ProductAttribute": { ported: "src/models/config_overrides.ts (product.attribute write)", src: "product/models/product_attribute.py:108" },
  // ------------------------------------------------------------------------------ the warehouse's steps (r12 fix 2)
  "write stock.models.stock_location:StockRoute": { ported: "src/models/stock_warehouse.ts (stock.route write)", src: "stock/models/stock_location.py:548" },
  "write stock.models.stock_location:StockLocation": { ported: "src/models/stock_warehouse.ts (stock.location write)", src: "stock/models/stock_location.py:213" },
  "write stock.models.stock_picking_type:StockPickingType": {
    ported: "src/models/stock_warehouse.ts (stock.picking.type write)", when: ["reservation_method"], src: "stock/models/stock_picking_type.py:303",
  },
  "create stock.models.stock_picking_type:StockPickingType": { ported: "src/models/stock_warehouse.ts (stock.picking.type create: the sequence)", src: "stock/models/stock_picking_type.py:276" },
  // the steps, the name and the code; archiving with ongoing operations (the UserError); a new address, archiving
  // otherwise and resupply warehouses refuse (in the port, before anything is written)
  "write stock.models.stock_warehouse:StockWarehouse": {
    ported: "src/models/stock_warehouse.ts (stock.warehouse write)", when: ["partner_id", "buy_to_resupply"], src: "stock/models/stock_warehouse.py:174",
  },
  // create: locations, sequences and operation types, routes and rules, the partner's transit properties and the
  // multi-warehouse group (through the settings' execute); resupply warehouses refuse
  "create stock.models.stock_warehouse:StockWarehouse": { ported: "src/models/stock_warehouse.ts (stock.warehouse create)", src: "stock/models/stock_warehouse.py:113" },
  "unlink stock.models.stock_warehouse:StockWarehouse": { ported: "src/models/stock_warehouse.ts (stock.warehouse unlink: the multi-warehouse group)", src: "stock/models/stock_warehouse.py:303" },
  // --------------------------------------------------------------------------------------------- measured in the suite
  "create account.models.account_account:AccountAccount": { ported: "src/models/account_journal_create.ts create (with its refusals)", src: "account/models/account_account.py:1011" },
  "create mail.models.mail_activity:MailActivity": { ported: "the mail.activity hooks of src/mail/activity.ts (action_notify to others refuses)", src: "mail/models/mail_activity.py:323" },
  "write mail.models.mail_activity:MailActivity": { ported: "the mail.activity hooks of src/mail/activity.ts", src: "mail/models/mail_activity.py:362" },
  // the bus counter of overdue activities only (as threadAfterUnlink, src/mail/write_hooks.ts)
  "unlink mail.models.mail_activity:MailActivity": { ported: "the bus counter is not sent (src/mail/write_hooks.ts threadAfterUnlink)", src: "mail/models/mail_activity.py:408" },
  // a new deadline of a meeting's activity moves the meeting
  "write calendar.models.mail_activity:MailActivity": {
    when: ["date_deadline"], acts: (env, _m, ids) => exists(env, "SELECT 1 FROM mail_activity WHERE id = ANY($1::int[]) AND calendar_event_id IS NOT NULL LIMIT 1", [[...ids]]),
    src: "calendar/models/mail_activity.py:14",
  },
  "create base.models.ir_attachment:IrAttachment": { ported: "src/models/ir_attachment_create.ts create", src: "base/models/ir_attachment.py" },
  "write base.models.ir_attachment:IrAttachment": { ported: "src/models/ir_attachment_create.ts write", src: "base/models/ir_attachment.py" },
  "create product.models.ir_attachment:IrAttachment": { ported: "a product attachment refuses (src/models/ir_attachment_create.ts)", src: "product/models/ir_attachment.py:9" },
  "write account.models.ir_attachment:IrAttachment": { ported: "an attachment of a restricted audit trail refuses (src/models/ir_attachment_create.ts)", src: "account/models/ir_attachment.py:40" },
  // unlink: the ORM's superuser unlink of a deleted record's or message's attachments (src/orm/unlink.ts
  // unlinkAttachments; `_file_delete` only marks the files for the filestore's GC); a user's own unlink of attachments
  // (`check_access` on their documents, ir_attachment.py `_check_access_records`) is not ported
  "unlink base.models.ir_attachment:IrAttachment": {
    ported: "src/orm/unlink.ts unlinkAttachments (as superuser)", acts: (env) => Promise.resolve(!env.su), src: "base/models/ir_attachment.py:908",
  },
  // attachments of journal entries: the invoice PDF / UBL detached instead of deleted (:55-81) and the audit trail
  // (:20-37) refuse
  "unlink account.models.ir_attachment:IrAttachment": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM ir_attachment WHERE id = ANY($1::int[]) AND res_model = 'account.move' LIMIT 1", [[...ids]]),
    src: "account/models/ir_attachment.py:55",
  },
  "ondelete account.models.ir_attachment:IrAttachment._except_audit_trail": {
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM ir_attachment WHERE id = ANY($1::int[]) AND res_model = 'account.move' LIMIT 1", [[...ids]]),
    src: "account/models/ir_attachment.py:20",
  },
  "create product.models.product_pricelist_item:ProductPricelistItem": { ported: "src/models/pricelist.ts create (the variant's template)", src: "product/models/product_pricelist_item.py:469" },
  // `_sanitize_vals` (:126-131): a variant without a template gets the variant's template, the value the stored
  // (pre)compute `_compute_product_tmpl_id` (:77-81, src/models/sps_menus.ts) gives for the same values
  "create product.models.product_supplierinfo:ProductSupplierinfo": { ported: "the product_tmpl_id compute of src/models/sps_menus.ts", src: "product/models/product_supplierinfo.py:133" },
  "write product.models.product_supplierinfo:ProductSupplierinfo": { ported: "the product_tmpl_id compute of src/models/sps_menus.ts", src: "product/models/product_supplierinfo.py:139" },
  // :457-479 the side effects of toggling live mode or archiving (tokens, payment methods), then
  // `_check_required_if_provider`, which only requires fields of providers in live mode
  "write payment.models.payment_provider:PaymentProvider": {
    when: ["is_live", "active"],
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM payment_provider WHERE id = ANY($1::int[]) AND is_live LIMIT 1", [[...ids]]),
    src: "payment/models/payment_provider.py:457",
  },
  // `_check_required_if_provider` of an enabled provider (a new one is disabled)
  "create payment.models.payment_provider:PaymentProvider": {
    reads: ["state"], acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["state"] && v["state"] !== "disabled"), src: "payment/models/payment_provider.py:451",
  },
  // a section or note line has no product, quantity or unit
  "create sale_management.models.sale_order_template_line:SaleOrderTemplateLine": {
    acts: async (env, _m, _ids, valsList) => valsList.some((v) => v["display_type"] || (!("display_type" in v) && env.context["default_display_type"])),
    src: "sale_management/models/sale_order_template_line.py:329",
  },
  "create stock.models.stock_location:StockLocation": { ported: "the warehouse_id cache invalidation is the port's none", src: "stock/models/stock_location.py:287" },
  "create stock.models.stock_move_line:StockMoveLine": { ported: "src/models/stock_engine.ts create (with its refusals)", src: "stock/models/stock_move_line.py:349" },
  "write stock.models.stock_move_line:StockMoveLine": { ported: "src/models/stock_engine.ts write (with its refusals)", src: "stock/models/stock_move_line.py:435" },
  // the valuation of valued moves (`_set_value`) and their analytic lines follow lines of done moves
  "write stock_account.models.stock_move_line:StockMoveLine": {
    when: ["quantity", "move_id", "location_id", "location_dest_id", "owner_id", "quant_id", "lot_id"],
    acts: (env, _m, ids) => exists(env, "SELECT 1 FROM stock_move_line l JOIN stock_move m ON m.id = l.move_id WHERE l.id = ANY($1::int[]) AND m.state = 'done' LIMIT 1", [[...ids]]),
    src: "stock_account/models/stock_move_line.py:15",
  },
  "create stock_account.models.stock_move_line:StockMoveLine": {
    reads: ["move_id"], acts: async (env, _m, _ids, valsList) => {
      const moves = valsList.map((v) => idOf(v["move_id"])).filter((m): m is number => m !== null);
      return moves.length > 0 && exists(env, "SELECT 1 FROM stock_move WHERE id = ANY($1::int[]) AND state = 'done' LIMIT 1", [moves]);
    },
    src: "stock_account/models/stock_move_line.py:7",
  },
  // a snoozed orderpoint must be manual (UserError)
  "create stock.models.stock_orderpoint:StockWarehouseOrderpoint": {
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["snoozed_until"]), src: "stock/models/stock_orderpoint.py:330",
  },
  "write stock.models.stock_orderpoint:StockWarehouseOrderpoint": {
    ported: "src/models/sweep_purchase_stock.ts write", src: "stock/models/stock_orderpoint.py:336",
  },
  // ------------------------------------------------------------------------------------------- res.config.settings
  // create drops the related values that did not change; the inverses and `execute` (set_values) are ported there
  "create base.models.res_config:ResConfigSettings": { ported: "src/models/res_config_settings_save.ts create", src: "base/models/res_config.py:518" },
  // ------------------------------------------------------------------------------------------- ir.config_parameter
  // each module acts on its own keys: analytic's project plan (columns), crm's PLS fields (registry), mail's allowed
  // catchall domains (sanitized), sale's cron switch, base's protected keys (renaming refused with ValidationError)
  "write analytic.models.ir_config_parameter:IrConfigParameter": { acts: (env, _m, ids) => paramKeys(env, ids, ["analytic.project_plan"]), src: "analytic/models/ir_config_parameter.py:11" },
  "write crm.models.ir_config_parameter:IrConfig_Parameter": { acts: (env, _m, ids) => paramKeys(env, ids, ["crm.pls_fields"]), src: "crm/models/ir_config_parameter.py:10" },
  "create crm.models.ir_config_parameter:IrConfig_Parameter": { acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["key"] === "crm.pls_fields"), src: "crm/models/ir_config_parameter.py" },
  "write mail.models.ir_config_parameter:IrConfig_Parameter": {
    when: ["value"], acts: async (env, _m, ids, [vals]) => vals?.["key"] === "mail.catchall.domain.allowed" || await paramKeys(env, ids, ["mail.catchall.domain.allowed"]),
    src: "mail/models/ir_config_parameter.py:123",
  },
  "create mail.models.ir_config_parameter:IrConfig_Parameter": {
    acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["key"] === "mail.catchall.domain.allowed" && v["value"]), src: "mail/models/ir_config_parameter.py:117",
  },
  "write sale.models.ir_config_parameter:IrConfigParameter": { acts: (env, _m, ids, [vals]) => vals?.["key"] === "sale.async_emails" ? Promise.resolve(true) : paramKeys(env, ids, ["sale.async_emails"]), src: "sale/models/ir_config_parameter.py:18" },
  "create sale.models.ir_config_parameter:IrConfigParameter": { acts: async (_env, _m, _ids, valsList) => valsList.some((v) => v["key"] === "sale.async_emails"), src: "sale/models/ir_config_parameter.py:12" },
  "write base.models.ir_config_parameter:IrConfig_Parameter": {
    when: ["key"], acts: (env, _m, ids) => paramKeys(env, ids, ["database.secret", "database.uuid", "database.create_date", "web.base.url", "base.login_cooldown_after", "base.login_cooldown_duration"]),
    src: "base/models/ir_config_parameter.py:163",
  },
  // ------------------------------------------------------------------------------------- product variants (åtgärd 7)
  "create product.models.product_template_attribute_line:ProductTemplateAttributeLine": {
    ported: "src/models/product_variants.ts create (values and variants; reactivations and replaced variants refuse)", src: "product/models/product_template_attribute_line.py:81",
  },
  // a value's variants, attribute value or template cannot change (UserError); new exclusions recreate the variants
  "write product.models.product_template_attribute_value:ProductTemplateAttributeValue": {
    when: ["ptav_product_variant_ids", "product_attribute_value_id", "product_tmpl_id", "excluded_value_ids"], src: "product/models/product_template_attribute_value.py:100",
  },
  // a value used on products cannot move to another attribute (UserError); a new sequence only invalidates caches
  "write product.models.product_attribute_value:ProductAttributeValue": { when: ["attribute_id"], src: "product/models/product_attribute_value.py:97" },
  // the variants of a value cannot be given (UserError)
  "create product.models.product_template_attribute_value:ProductTemplateAttributeValue": { when: ["ptav_product_variant_ids"], src: "product/models/product_template_attribute_value.py:92" },
};

export { commandValues };
