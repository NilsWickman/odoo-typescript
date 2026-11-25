/**
 * sale.order, sale.order.template and quotation.document computes, searches, selections and defaults
 * (odoo/addons/sale, sale_stock, sale_management, sale_pdf_quote_builder). Each body cites its source.
 */
import { PrivateRecords } from "../orm/private_hooks";
import { NotPorted } from "../errors";
import { and, cond, isNegativeOperator, or } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { pyFloat, str2bool } from "../orm/values";
import { toFixedHalfEven } from "../pyexpr/values";
import { roundMonetary } from "../orm/convert";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerOverrides, write } from "../orm/write";
import { DbRec, type Rec, registerDefaults, registerRecordCompute } from "../orm/recompute";
import type { Domain, Environment, PyFloat } from "../orm/types";
import { registerActivityMixin } from "./crm_activity";
import { registerGroupExpand } from "../web/read_group";
import { roundPrecision, floatIsZero } from "./account_tax_engine";
import { addressGet, configParam, defineComputes, filteredAccess, withCompany, registerIsFollower, registerNeedaction, relatedSelection, searchMethod, registerDefaultValued } from "./tail_util";
import { datetimeToString, dbNow, translate } from "./util";
import { isInstalled } from "../http/modules";
import { contextToday } from "./account_computes";
import { isHtmlEmpty } from "./crm_lead_lost_write";
import * as priv from "../orm/dispatch_gen";

/** "YYYY-MM-DD HH:MM:SS" (UTC) plus a float number of days, as `datetime + timedelta(days=...)`, back to a string. */
function addDays(value: string, days: number): string {
  const ms = Date.parse(`${value.replace(" ", "T")}Z`) + Math.round(days * 86400 * 1000);
  return datetimeToString(new Date(ms));
}

/**
 * sale_order.py:1083-1104 _compute_expected_date (sale_stock sale_order.py:91-93 keeps it) with
 * sale_order_line.py:2007-2013 `_expected_date` and sale_stock sale_order.py:116-120 `_select_expected_date`.
 */
async function expectedDate(env: Environment, rec: Rec): Promise<string | null> {
  const state = await rec.get("state");
  if (state === "cancel") return null;
  const dates: string[] = [];
  for (const line of await rec.rels("order_line")) {
    const product = await line.rel("product_id");
    if (product && (await product.get("type")) !== "consu") continue;
    if (await line.get("display_type")) continue;
    // sale_order_line.py:2226 _is_delivery: False (the delivery module is not installed)
    if ((env.reg.model("sale.order.line").modules ?? []).includes("delivery")) throw new NotPorted("sale.order.line._is_delivery of the delivery module");
    const dateOrder = await rec.get("date_order");
    // fields.Datetime.now() keeps the microseconds; the read format drops them
    const orderDate = (await line.get("state")) === "sale" && typeof dateOrder === "string" ? dateOrder : datetimeToString(await dbNow(env));
    const lead = await line.get("customer_lead");
    dates.push(addDays(orderDate, typeof lead === "number" ? lead : 0));
  }
  if (dates.length === 0) return null;
  dates.sort();
  return (await rec.get("picking_policy")) === "direct" ? dates[0]! : dates[dates.length - 1]!;
}

defineComputes("sale.order", {
  expected_date: expectedDate,
  // sale_order.py:1241-1244 _compute_delivery_date, then sale_stock sale_order.py:102-106: effective_date first
  delivery_date: async (env, rec) => {
    const commitment = await rec.get("commitment_date");
    const base = commitment || (await expectedDate(env, rec));
    const effective = await rec.get("effective_date");
    return effective || base || null;
  },
  // sale_stock sale_order.py:203-206 _compute_picking_ids: len(picking_ids)
  delivery_count: async (_env, rec) => (await rec.rels("picking_ids")).length,
});

// sale_order.py:439 company_price_include = related company_id.account_price_include
registerHooks("sale.order", { selection: { company_price_include: relatedSelection("res.company", "account_price_include") } });
registerHooks("sale.order.line", { selection: { company_price_include: relatedSelection("res.company", "account_price_include") } });

registerDefaults("sale.order", {
  // sale_pdf_quote_builder sale_order.py:11-16 _default_quotation_document_ids with models.py:3339 _check_company_domain
  quotation_document_ids: async (env) => {
    const ids = await env.model("quotation.document").search(and([
      cond("company_id", "in", [await env.company(), false]),
      cond("quotation_template_ids", "=", false),
      cond("add_by_default", "=", true),
    ]));
    return [[6, 0, ids]];
  },
});

/** sale_management sale_order_template.py:102-113 _compute_user_has_access. */
async function userHasAccess(env: Environment, rec: Rec): Promise<boolean> {
  const share = await rec.get("share_template");
  if (share) {
    const teams = await rec.rels("team_ids");
    if (teams.length === 0) return true;
    for (const team of teams) {
      if ((await team.get("user_id")) === env.uid) return true;
      const memberIds = await team.get("member_ids");
      if (Array.isArray(memberIds) && memberIds.includes(env.uid)) return true;
    }
  }
  return (await rec.get("create_uid")) === env.uid;
}

/** sale_order_template.py:115-132 _search_user_has_access for '=' / '!=' with a boolean. */
function searchUserHasAccess(env: Environment, operator: string, value: unknown): Domain {
  const truthy = Boolean(value);
  const x2many = (operator === "=" && truthy) || (operator === "!=" && !truthy) ? "in" : "not in";
  return or([
    and([
      cond("share_template", operator, value),
      or([cond("team_ids", operator, !truthy), cond("team_ids.member_ids", x2many, [env.uid]), cond("team_ids.user_id", x2many, [env.uid])]),
    ]),
    cond("create_uid", x2many, [env.uid]),
  ]);
}

defineComputes("sale.order.template", {
  user_has_access: userHasAccess,
  // sale_order_template.py:133-139 _compute_has_productless_lines
  has_productless_lines: async (_env, rec) => {
    for (const line of await rec.rels("sale_order_template_line_ids")) {
      if (!(await line.get("product_id")) && !(await line.get("display_type"))) return true;
    }
    return false;
  },
});
registerHooks("sale.order.template", {
  search: {
    user_has_access: searchMethod("sale.order.template", "user_has_access", async (env, operator, value) =>
      operator === "=" || operator === "!=" ? searchUserHasAccess(env, operator, value) : null),
  },
});

// quotation.document `type` = related ir_attachment_id.type (_inherits ir.attachment)
registerHooks("quotation.document", { selection: { type: relatedSelection("ir.attachment", "type") } });
registerHooks("product.document", { selection: { type: relatedSelection("ir.attachment", "type") } });

registerActivityMixin("sale.order");
registerNeedaction("sale.order");
registerIsFollower("sale.order");

registerHooks("sale.order", {
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the ones registered before
  descriptionDomain: {
    ...hooksOf("sale.order").descriptionDomain,
    // sale_order.py:300-304: the formatted string with env.ref('sales_team.group_sale_salesman').ids
    user_id: async (env) => {
      const id = await env.reg.xmlid(env.cr, "sales_team.group_sale_salesman");
      if (id === null) throw new NotPorted("env.ref('sales_team.group_sale_salesman') of a missing record");
      return `[('all_group_ids', 'in', [${id}]), ('share', '=', False), ('company_ids', '=', company_id)]`;
    },
  },
});
registerHooks("sale.order.template.line", {
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the ones registered before
  descriptionDomain: {
    ...hooksOf("sale.order.template.line").descriptionDomain,
    // sale_management sale_order_template_line.py:57: the description domain of the line's product_id
    product_template_id: async (env) => {
      const f = env.reg.model("sale.order.template.line").fields.get("product_id");
      if (!f || f.domainCallable || f.descriptionDomain === undefined) throw new NotPorted("sale.order.template.line.product_id description domain");
      return f.descriptionDomain;
    },
  },
});

/** `(record.company_id or env.company).<field>` of res.company. */
async function companyValue(env: Environment, rec: Rec, column: "portal_confirmation_sign" | "portal_confirmation_pay" | "prepayment_percent"): Promise<unknown> {
  const company = await rec.get("company_id");
  const id = typeof company === "number" && company ? company : await env.company();
  return (await env.cr.query<{ v: unknown }>(`SELECT ${column} AS v FROM res_company WHERE id = $1`, [id])).rows[0]?.v ?? null;
}
registerRecordCompute("sale.order.template", {
  // sale_order_template.py:85-90 _compute_require_signature (stored)
  require_signature: async (env, rec) => Boolean(await companyValue(env, rec, "portal_confirmation_sign")),
  // sale_order_template.py:92-100 _compute_prepayment_percent (stored)
  prepayment_percent: async (env, rec) => {
    if (!(await companyValue(env, rec, "portal_confirmation_pay"))) return 0;
    const v = await companyValue(env, rec, "prepayment_percent");
    return v === null ? null : Number(v);
  },
});

/** product_template.py:1855-1862 and product_product.py:1444-1449 `_get_available_uoms` of a product. */
export async function availableUoms(env: Environment, product: Rec | null): Promise<number[]> {
  if (!product) return [];
  const template = await product.rel("product_tmpl_id");
  if (!template) return [];
  const uom = await template.get("uom_id");
  const out: number[] = typeof uom === "number" && uom ? [uom] : [];
  // res_groups.py:574 _is_feature_enabled: whether the superuser has the group
  if (!(await hasGroup(env.withUser(1), "uom.group_uom"))) return out;
  for (const r of [...(await template.rels("uom_ids")), ...(await product.rels("extra_uom_ids"))]) {
    if (r.origin !== null && !out.includes(r.origin)) out.push(r.origin);
  }
  return out;
}

defineComputes("sale.order.template.line", {
  // sale_order_template_line.py:156-159 _compute_product_template_id
  product_template_id: async (_env, rec) => {
    const product = await rec.rel("product_id");
    return product ? (await product.get("product_tmpl_id")) || null : null;
  },
  // sale_order_template_line.py:282-286 _compute_mandatory_product: get_bool('sale.mandatory_product')
  mandatory_product: async (env) => {
    const v = await configParam(env, "sale.mandatory_product");
    return v === null ? false : str2bool(v, false);
  },
  // sale_order_template_line.py:246-249 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUoms(env, await rec.rel("product_id")),
});
registerHooks("sale.order.template.line", {
  search: {
    // sale_order_template_line.py:161-167 _search_product_template_id
    product_template_id: searchMethod("sale.order.template.line", "product_template_id", async (_env, operator, value) => {
      if (isNegativeOperator(operator)) return null;
      const domain = cond("product_id.product_tmpl_id", operator, value);
      if (operator === "in" && Array.isArray(value) && value.includes(false)) return or([domain, cond("product_id", "=", false)]);
      return domain;
    }),
  },
});

defineComputes("sale.order", {
  // portal_mixin.py:30-32 then sale_order.py:1217-1220 _compute_access_url
  access_url: async (_env, rec) => {
    if (rec.id === null) throw new NotPorted("sale.order.access_url of a new order (NewId repr)");
    return `/my/orders/${rec.id}`;
  },
});
/** res_partner.py:938-941 _compute_has_vat. */
function hasVatValue(vat: unknown): boolean {
  return typeof vat === "string" && vat !== "" && !["/", "na", "NA"].includes(vat);
}

/**
 * account partner.py:259-291 `account.fiscal.position._get_fiscal_position(partner, delivery)` with env.company the
 * given company (sudo: the callers are compute_sudo stored computes); the auto-applied positions are matched by
 * `_get_first_matching_fpos` (partner.py:220-256).
 */
export async function fiscalPositionFor(env0: Environment, company: number, partner: number, delivery: number | null): Promise<number | null> {
  const env = await withCompany(env0.sudo(), company);
  const P = (id: number) => new DbRec(env, env.reg.model("res.partner"), id);
  const comp = new DbRec(env, env.reg.model("res.company"), company);
  const partnerRec = P(partner);
  const companyVat = await comp.get("vat");
  const partnerVat = await partnerRec.get("vat");
  let intraEu = false, vatExclusion = false;
  if (hasVatValue(companyVat) && hasVatValue(partnerVat)) {
    const europe = await env.reg.xmlid(env.cr, "base.europe");
    const codes = new Set(europe === null ? [] : (await env.cr.query<{ code: string }>(
      `SELECT c.code FROM res_country c JOIN res_country_res_country_group_rel r ON r.res_country_id = c.id
       WHERE r.res_country_group_id = $1`, [europe])).rows.map((r) => r.code));
    const cp = String(companyVat).slice(0, 2), pp = String(partnerVat).slice(0, 2);
    intraEu = codes.has(cp) && codes.has(pp);
    vatExclusion = cp === pp;
  }
  const partnerCountry = await partnerRec.get("country_id");
  let deliveryId = delivery;
  if (!deliveryId || (intraEu && vatExclusion && (partnerCountry || null) === ((await comp.get("country_id")) || null))) deliveryId = partner;
  const deliveryRec = P(deliveryId);
  // partner.py:279-284 the manually set position (company-dependent) always wins
  const manual = (await deliveryRec.get("property_account_position_id")) || (await partnerRec.get("property_account_position_id"));
  if (manual) return Number(manual);
  if (!partnerCountry) return null;
  // models.py:3339-3349 _check_company_domain(env.company): company_id in (company, False)
  const fposIds = await env.model("account.fiscal.position").search(and([
    cond("company_id", "in", [company, false]),
    cond("auto_apply", "=", true),
  ]));
  if (fposIds.length === 0) return null;
  if (await isInstalled(env.cr, "l10n_ar") || await isInstalled(env.cr, "l10n_br")) {
    throw new NotPorted("account.fiscal.position matching with l10n_ar / l10n_br overrides");
  }
  const F = (id: number) => new DbRec(env, env.reg.model("account.fiscal.position"), id);
  // sorted by (-len(company_id.sudo().parent_ids), sequence), stable over the search order (sequence, id)
  const keyed: { id: number; depth: number; seq: number; pos: number }[] = [];
  for (const [pos, id] of fposIds.entries()) {
    const fc = await F(id).rel("company_id");
    const depth = fc ? ((await fc.get("parent_ids")) as unknown[] | null ?? []).length : 0;
    keyed.push({ id, depth, seq: Number((await F(id).get("sequence")) ?? 0), pos });
  }
  keyed.sort((a, b) => (b.depth - a.depth) || (a.seq - b.seq) || (a.pos - b.pos));
  const dZip = await deliveryRec.get("zip");
  const dState = (await deliveryRec.get("state_id")) || null;
  const dCountry = (await deliveryRec.get("country_id")) || null;
  const dVat = await deliveryRec.get("vat");
  // partner.py:231-234 `partner._get_vat_required_valid(company=self.env.company)` for each position requiring a VAT,
  // through the private hook: a site's compiled override (l10n_eu_account_vies: also vies_valid where VIES validation
  // applies) runs around account's `has_vat`
  const vatRequiredValid = async (): Promise<boolean> => Boolean(await priv.res_partner._get_vat_required_valid.call(env, [deliveryId!],
    [new PrivateRecords("res.company", [company])], async () => hasVatValue(dVat)));
  for (const { id } of keyed) {
    const f = F(id);
    if ((await f.get("vat_required")) && !(await vatRequiredValid())) continue;
    const zipFrom = await f.get("zip_from"), zipTo = await f.get("zip_to");
    if (zipFrom && zipTo && !(dZip && String(zipFrom) <= String(dZip) && String(dZip) <= String(zipTo))) continue;
    const states = ((await f.get("state_ids")) as number[] | null) ?? [];
    if (states.length && !(dState !== null && states.includes(Number(dState)))) continue;
    const country = (await f.get("country_id")) || null;
    if (country && country !== dCountry) continue;
    const group = await f.rel("country_group_id");
    if (group) {
      const countries = ((await group.get("country_ids")) as number[] | null) ?? [];
      const excluded = ((await group.get("exclude_state_ids")) as number[] | null) ?? [];
      if (!(dCountry !== null && countries.includes(Number(dCountry)) && (dState === null || !excluded.includes(Number(dState))))) continue;
    }
    return id;
  }
  return null;
}
registerRecordCompute("sale.order", {
  // sale_order.py:563-581 _compute_note (stored): with account.use_invoice_terms, drafts take the company's terms
  // (the HTML terms page link is not ported), in the customer's language; extended by sale_management
  // sale_order.py:30-35: the quotation template's note when not empty
  note: async (env, rec) => {
    let note = await rec.prev("note");
    const param = await configParam(env, "account.use_invoice_terms");
    const partner = await rec.rel("partner_id");
    const partnerLang = partner ? await partner.get("lang") : null;
    const sameLang = !partnerLang || partnerLang === (env.lang ?? "en_US");
    if (param !== null && str2bool(param, false) && (await rec.get("state")) === "draft") {
      const company = await rec.rel("company_id");
      if (company) {
        if ((await company.get("terms_type")) === "html" && (await company.get("invoice_terms_html"))) {
          throw new NotPorted("sale.order.note from the HTML terms page (html_keep_url)");
        }
        const terms = await company.get("invoice_terms");
        if (!isHtmlEmpty(typeof terms === "string" ? terms : null)) {
          if (!sameLang) throw new NotPorted("sale.order.note: invoice terms in the customer's language");
          note = terms;
        }
      }
    }
    const modules = env.reg.model("sale.order").modules ?? [];
    const template = modules.includes("sale_management") ? await rec.rel("sale_order_template_id") : null;
    if (template) {
      if (!sameLang) throw new NotPorted("sale.order.note: quotation template note in the customer's language");
      const tnote = await template.get("note");
      if (!isHtmlEmpty(typeof tnote === "string" ? tnote : null)) note = tnote;
    }
    return note;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:560-561 _compute_journal_id (stored, readonly=False): no journal, extended by sale_management
  // sale_order.py:58-62 (the quotation template's journal); website_sale's extension is not ported
  journal_id: async (env, rec) => {
    const modules = env.reg.model("sale.order").modules ?? [];
    if (modules.includes("website_sale") || modules.includes("l10n_es_website_sale")) throw new NotPorted("sale.order.journal_id with website_sale");
    const template = modules.includes("sale_management") ? await rec.rel("sale_order_template_id") : null;
    return template ? (await template.get("journal_id")) || null : null;
  },
});
/**
 * sales_team crm_team.py:19-81 `_get_default_team_id(user_id, domain)`: the user's teams (member or leader) in the
 * allowed companies matching the domain, else any of them, else the context default, else the company's teams.
 */
export async function defaultSalesTeam(env: Environment, userId: number | null, domain: Domain): Promise<number | null> {
  const uid = userId ?? env.uid;
  const ctxTeam = env.context["default_team_id"];
  const defaultTeamId = typeof ctxTeam === "number" && ctxTeam ? ctxTeam : null;
  const userCompanies = await new DbRec(env.sudo(), env.reg.model("res.users"), uid).get("company_ids");
  const allowed = new Set(await env.companies());
  const validCids: (number | false)[] = [false, ...(Array.isArray(userCompanies) ? (userCompanies as number[]) : []).filter((c) => allowed.has(c))];
  const Team = env.model("crm.team");
  const filtered = async (ids: number[]): Promise<number[]> => {
    if (!ids.length) return [];
    const found = new Set(await Team.search(and([cond("id", "in", ids), domain]), { activeTest: false }));
    return ids.filter((id) => found.has(id)); // filtered_domain keeps the order
  };
  let team: number | null = null;
  const teams = await Team.search(and([cond("company_id", "in", validCids), or([cond("user_id", "=", uid), cond("member_ids", "in", [uid])])]));
  if (teams.length) {
    const f = await filtered(teams);
    team = defaultTeamId !== null && f.includes(defaultTeamId) ? defaultTeamId : f[0] ?? null;
  }
  if (team === null) team = defaultTeamId !== null && teams.includes(defaultTeamId) ? defaultTeamId : teams[0] ?? null;
  if (team === null && defaultTeamId !== null) team = defaultTeamId;
  if (team === null) {
    const all = await Team.search(cond("company_id", "in", validCids));
    if (all.length) team = (await filtered(all))[0] ?? null;
    if (team === null) team = all[0] ?? null;
  }
  return team;
}
registerRecordCompute("sale.order", {
  // sale_stock sale_order.py:208-218 _compute_warehouse_id (stored): drafts and unsaved orders take the ir.default
  // (refused), else the salesperson's default warehouse for the order's company (sale_stock res_users.py:11-14
  // property_warehouse_id, stock res_users.py:9-12 the company's first warehouse); confirmed orders keep theirs
  warehouse_id: async (env, rec) => {
    const current = await rec.prev("warehouse_id");
    const state = await rec.get("state");
    if (!(state === "draft" || state === "sent" || rec.id === null)) return current;
    const companyField = await rec.get("company_id");
    const company = typeof companyField === "number" && companyField ? companyField : await env.company();
    const defaults = (await env.cr.query(
      `SELECT 1 FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
        WHERE f.model = 'sale.order' AND f.name = 'warehouse_id' AND (d.user_id IS NULL OR d.user_id = $1)
          AND (d.company_id IS NULL OR d.company_id = $2)`, [env.uid, company])).rows.length;
    if (defaults) throw new NotPorted("sale.order.warehouse_id from an ir.default");
    const cenv = await withCompany(env, company);
    const user = await rec.get("user_id");
    if (typeof user === "number" && user) {
      const own = await new DbRec(cenv, env.reg.model("res.users"), user).get("property_warehouse_id");
      if (own) return own;
    }
    const found = await cenv.model("stock.warehouse").search(cond("company_id", "=", company), { limit: 1 });
    return found[0] ?? null;
  },
});
/** `date + timedelta(days)` on 'YYYY-MM-DD'. */
function addDaysToDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
}
registerRecordCompute("sale.order", {
  // sale_order.py:554-562 _compute_validity_date (stored): context today plus the company's quotation validity;
  // sale_management sale_order.py:50-57: the quotation template's number of days when positive
  validity_date: async (env, rec) => {
    const today = await contextToday(env);
    let value: string | null = null;
    const company = await rec.rel("company_id");
    const days = company ? Number((await company.get("quotation_validity_days")) ?? 0) : 0;
    if (days > 0) value = addDaysToDate(today, days);
    const modules = env.reg.model("sale.order").modules ?? [];
    const template = modules.includes("sale_management") ? await rec.rel("sale_order_template_id") : null;
    if (template) {
      const tdays = Number((await template.get("number_of_days")) ?? 0);
      if (tdays > 0) value = addDaysToDate(today, tdays);
    }
    return value;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:676-687 _compute_user_id (stored): on a customer, the customer's (or its commercial entity's)
  // salesperson, else the current user if a salesman; saved orders with a salesperson keep it
  user_id: async (env, rec) => {
    const current = await rec.prev("user_id");
    const partner = await rec.rel("partner_id");
    const savedId = rec.id ?? rec.origin;
    if (!partner || (savedId !== null && current)) return current;
    const own = await partner.get("user_id");
    if (own) return own;
    const commercial = await partner.rel("commercial_partner_id");
    const fromCommercial = commercial ? await commercial.get("user_id") : null;
    if (fromCommercial) return fromCommercial;
    return (await hasGroup(env, "sales_team.group_sale_salesman")) ? env.uid : null;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:688-706 _compute_team_id (stored): the default team of the salesperson within the order's company
  // (`_default_team_id`, :719-720: the context default, else the current team)
  team_id: async (env, rec) => {
    const ctx = env.context["default_team_id"];
    const current = await rec.prev("team_id");
    const defaultTeamId = ctx || (typeof current === "number" ? current : false);
    const user = await rec.get("user_id");
    const company = await rec.get("company_id");
    const domain = typeof company === "number" && company ? cond("company_id", "in", [company, false]) : cond("company_id", "=", false);
    const tenv = env.withContext({ ...env.context, default_team_id: defaultTeamId });
    return defaultSalesTeam(tenv, typeof user === "number" && user ? user : null, domain);
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:709-712 _compute_incoterm (stored, precompute): the customer's incoterm, else the company's
  incoterm: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    const fromPartner = partner ? await partner.get("incoterm_id") : null;
    if (fromPartner) return fromPartner;
    const company = await rec.rel("company_id");
    return company ? (await company.get("incoterm_id")) || null : null;
  },
  // sale_order.py:714-717 _compute_incoterm_location (stored, precompute)
  incoterm_location: async (_env, rec) => {
    const partner = await rec.rel("partner_id");
    return partner ? (await partner.get("incoterm_location")) || false : false;
  },
});
/** A company-dependent field of the order's customer as seen with the order's company (`with_company`). */
async function partnerPropertyWithCompany(env: Environment, rec: Rec, fname: string): Promise<unknown> {
  const partner = await rec.get("partner_id");
  if (typeof partner !== "number" || !partner) return null;
  const company = await rec.get("company_id");
  const cenv = typeof company === "number" && company ? await withCompany(env, company) : env;
  return (await new DbRec(cenv, env.reg.model("res.partner"), partner).get(fname)) || null;
}
registerRecordCompute("sale.order", {
  // sale_order.py:625-629 _compute_payment_term_id (stored): the customer's payment terms for the order's company;
  // website_sale's fallback (sale_order.py:125-140) is not ported
  payment_term_id: async (env, rec) => {
    if ((env.reg.model("sale.order").modules ?? []).includes("website_sale")) throw new NotPorted("sale.order.payment_term_id with website_sale");
    return partnerPropertyWithCompany(env, rec, "property_payment_term_id");
  },
  // sale_order.py:631-637 _compute_preferred_payment_method_line_id (stored)
  preferred_payment_method_line_id: async (env, rec) => partnerPropertyWithCompany(env, rec, "property_inbound_payment_method_line_id"),
});
registerRecordCompute("sale.order", {
  // sale_order.py:525-528 _compute_require_signature (stored): the company's online signature setting;
  // sale_management sale_order.py:38-42: the quotation template's; website_sale's (website orders) is refused
  require_signature: async (env, rec) => {
    const modules = env.reg.model("sale.order").modules ?? [];
    if (modules.includes("website_sale")) throw new NotPorted("sale.order.require_signature with website_sale");
    const template = modules.includes("sale_management") ? await rec.rel("sale_order_template_id") : null;
    if (template) return Boolean(await template.get("require_signature"));
    const company = await rec.rel("company_id");
    return company ? Boolean(await company.get("portal_confirmation_sign")) : false;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:530-536 _compute_prepayment_percent (stored): the company's when online payment confirms, else 0;
  // sale_management sale_order.py:44-48: the quotation template's
  prepayment_percent: async (env, rec) => {
    const modules = env.reg.model("sale.order").modules ?? [];
    const template = modules.includes("sale_management") ? await rec.rel("sale_order_template_id") : null;
    if (template) return Number((await template.get("prepayment_percent")) ?? 0);
    const company = await rec.rel("company_id");
    if (company && (await company.get("portal_confirmation_pay"))) return Number((await company.get("prepayment_percent")) ?? 0);
    return 0;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:592-597 _compute_partner_invoice_id (stored): the customer's invoice address
  partner_invoice_id: async (env, rec) => {
    const partner = await rec.get("partner_id");
    return typeof partner === "number" && partner ? (await addressGet(env, partner, ["invoice"]))["invoice"]! : null;
  },
  // sale_order.py:599-605 _compute_partner_shipping_id (stored): the customer's delivery address
  partner_shipping_id: async (env, rec) => {
    const partner = await rec.get("partner_id");
    return typeof partner === "number" && partner ? (await addressGet(env, partner, ["delivery"]))["delivery"]! : null;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:607-624 _compute_fiscal_position_id (stored, compute_sudo): none without a customer, else the
  // position for (customer, delivery address) with the order's company
  fiscal_position_id: async (env, rec) => {
    const partner = await rec.get("partner_id");
    if (!partner) return null;
    const company = await rec.get("company_id");
    const shipping = await rec.get("partner_shipping_id");
    return fiscalPositionFor(env, typeof company === "number" ? company : await env.company(), Number(partner), typeof shipping === "number" ? shipping : null);
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:650-653 _compute_currency_id (stored, compute_sudo): the pricelist's currency, else the company's
  currency_id: async (env, rec) => {
    const pricelist = await rec.rel("pricelist_id");
    const fromPricelist = pricelist ? await pricelist.get("currency_id") : null;
    if (fromPricelist) return fromPricelist;
    const company = await rec.rel("company_id");
    return company ? (await company.get("currency_id")) || null : null;
  },
});
registerRecordCompute("sale.order", {
  // sale_order.py:865-916 _compute_invoice_status (stored)
  invoice_status: async (env, rec) => {
    if ((await rec.get("state")) !== "sale") return "no";
    if (await rec.get("invoicing_closed")) return "invoiced";
    if (rec.id === null) throw new NotPorted("sale.order.invoice_status of a new confirmed order");
    const lines = await rec.rels("order_line");
    const rows: { s: string | null; p: number | null; d: number | null }[] = [];
    for (const l of lines) {
      if ((await l.get("is_downpayment")) || (await l.get("display_type"))) continue;
      const comp = await l.rel("company_id");
      const p = await l.get("product_id");
      const d = comp ? await comp.get("sale_discount_product_id") : null;
      const s = await l.get("invoice_status");
      rows.push({ s: typeof s === "string" ? s : null, p: typeof p === "number" ? p : null, d: typeof d === "number" ? d : null });
    }
    const has = (s: string): boolean => rows.some((r) => r.s === s);
    if (has("to invoice")) {
      if (has("no") && rows.filter((r) => r.s === "to invoice").every((r) => r.p === r.d)) return "no";
      return "to invoice";
    }
    if (rows.length && rows.every((r) => r.s === "invoiced")) return "invoiced";
    if (rows.length && rows.every((r) => r.s === "invoiced" || r.s === "upselling")) return "upselling";
    return "no";
  },
});

registerRecordCompute("sale.order", {
  // sale_order.py:640-648 _compute_pricelist_id (stored): drafts take the customer's pricelist for the company
  pricelist_id: async (env, rec) => {
    if ((await rec.get("state")) !== "draft") return rec.prev("pricelist_id");
    const partner = await rec.get("partner_id");
    if (!partner) return null;
    // :648-649 `order.with_company(order.company_id).partner_id.property_product_pricelist` (product res_partner.py:41-53
    // via _get_partner_pricelist_multi, src/models/partner_erp.ts)
    const company = await rec.get("company_id");
    const cenv = typeof company === "number" ? await withCompany(env, company) : env;
    const { pricelists } = await import("./partner_erp");
    const pl = (await pricelists(cenv, [Number(partner)])).get(Number(partner));
    return typeof pl === "number" ? pl : null;
  },
});

registerRecordCompute("sale.order", {
  // sale_stock sale_order.py:76-89 _compute_delivery_status (stored)
  delivery_status: async (_env, rec) => {
    const pickings = await rec.rels("picking_ids");
    const states: string[] = [];
    for (const p of pickings) states.push(String(await p.get("state")));
    if (states.length === 0 || states.every((s) => s === "cancel")) return null;
    if (states.every((s) => s === "done" || s === "cancel")) return "full";
    if (states.some((s) => s === "done")) {
      for (const l of await rec.rels("order_line")) if (Number((await l.get("qty_delivered")) ?? 0)) return "partial";
      return "started";
    }
    return "pending";
  },
});
registerHooks("sale.order", {
  descriptionDomain: {
    ...hooksOf("sale.order").descriptionDomain,
    // sale_stock sale_order.py:27 warehouse_id domain=lambda self: [('company_id', 'in', self.env.companies.ids)]
    warehouse_id: async (env) => [["company_id", "in", [...await env.companies()]]],
  },
});

defineComputes("sale.order", {
  // sale_order.py:1034-1081 _compute_duplicated_order_ids with _fetch_duplicate_orders (draft orders with a reference)
  duplicated_order_ids: async (env, rec) => {
    if (rec.id === null || (await rec.get("state")) !== "draft" || !(await rec.get("client_order_ref"))) return [];
    const ids = (await env.cr.query<{ id: number }>(
      `SELECT DISTINCT d.id FROM sale_order s JOIN sale_order d ON s.company_id = d.company_id AND s.id != d.id
         AND d.state != 'cancel' AND s.partner_id = d.partner_id AND (s.origin = d.name OR s.client_order_ref = d.client_order_ref)
        WHERE s.id = $1`, [rec.id])).rows.map((r) => r.id);
    // Command.set(a Python set): its iteration order is not reproduced beyond one element
    if (ids.length > 1) throw new NotPorted("sale.order.duplicated_order_ids with several duplicates (set order)");
    return ids;
  },
});

registerRecordCompute("sale.order", {
  // sale_order.py:1251-1256 _compute_document_tax_mode (stored): kept, else the company's account_price_include
  document_tax_mode: async (env, rec) => {
    const current = await rec.prev("document_tax_mode");
    if (current) return current;
    const company = await rec.get("company_id");
    const id = typeof company === "number" && company ? company : await env.company();
    return (await env.cr.query<{ v: string | null }>("SELECT account_price_include AS v FROM res_company WHERE id = $1", [id])).rows[0]?.v ?? null;
  },
  // sale_stock sale_order.py:68-73 _compute_effective_date (stored): the earliest done delivery to a customer
  effective_date: async (_env, rec) => {
    const dates: string[] = [];
    for (const p of await rec.rels("picking_ids")) {
      if ((await p.get("state")) !== "done") continue;
      const dest = await p.rel("location_dest_id");
      if (!dest || (await dest.get("usage")) !== "customer") continue;
      const d = await p.get("date_done");
      if (typeof d === "string" && d) dates.push(d);
    }
    dates.sort();
    return dates[0] ?? null;
  },
});
registerDefaultValued("sale.order", "is_unfulfilled"); // sale_order.py:468-469 store=False without compute

// sale_order_line.py:107-118 (domain: the product_id description domain), :476-486 compute and search
registerHooks("sale.order.line", {
  descriptionDomain: {
    ...hooksOf("sale.order.line").descriptionDomain,
    product_template_id: async (env) => {
      const f = env.reg.model("sale.order.line").fields.get("product_id");
      if (!f || f.domainCallable || f.descriptionDomain === undefined) throw new NotPorted("sale.order.line.product_id description domain");
      return f.descriptionDomain;
    },
  },
  search: {
    product_template_id: searchMethod("sale.order.line", "product_template_id", async (_env, operator, value) => {
      if (isNegativeOperator(operator)) return null;
      const domain = cond("product_id.product_tmpl_id", operator, value);
      if (operator === "in" && Array.isArray(value) && value.includes(false)) return or([domain, cond("product_id", "=", false)]);
      return domain;
    }),
  },
});
if (hooksOf("sale.order.line").computed?.["product_template_id"] === undefined) {
  defineComputes("sale.order.line", {
    product_template_id: async (_env, rec) => {
      const product = await rec.rel("product_id");
      return product ? (await product.get("product_tmpl_id")) || null : null;
    },
  });
}

registerRecordCompute("quotation.document", {
  // sale_pdf_quote_builder quotation_document.py:74-83 _compute_form_field_ids (stored): cleared, then the PDF form
  // fields of documents with content (PDF parsing not ported)
  form_field_ids: async (_env, rec) => {
    if (await rec.get("raw")) throw new NotPorted("quotation.document form fields from the PDF content");
    return [];
  },
});

defineComputes("sale.order", {
  // sale_order.py:1193-1205 _compute_extra_total_fields with :955-1010 _get_advantages, then sale_margin
  // sale_order.py:33-49 (the margin line).
  extra_total_fields: async (env, rec) => {
    const basic: { sequence: number; name: string; lines: { label: string; value: PyFloat }[] } = { sequence: 1, name: "basic", lines: [] };
    const priced: Rec[] = [];
    let hasDiscountOrGlobal = false;
    for (const line of await rec.rels("order_line")) {
      if (await line.get("display_type")) continue;
      priced.push(line);
      if (Number((await line.get("discount")) ?? 0) > 0) hasDiscountOrGlobal = true;
      const extra = await line.get("extra_tax_data");
      if (extra && typeof extra === "object" && String((extra as Record<string, unknown>)["computation_key"] ?? "").startsWith("global_discount,")) {
        hasDiscountOrGlobal = true;
      }
    }
    if (hasDiscountOrGlobal && priced.length) {
      const { extendedTaxHelpers, saleLineBaseAll } = await import("./sweep_sale_product");
      const { companyData } = await import("./account_taxes");
      const companyId = await rec.get("company_id");
      const company = await companyData(env, typeof companyId === "number" && companyId ? companyId : await env.company());
      const currencyId = await rec.get("currency_id");
      const curRounding = typeof currencyId === "number" && currencyId
        ? Number((await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currencyId])).rows[0]?.r ?? 0.01)
        : company.currency_id.rounding;
      const baseLines = [];
      const undiscountedLines = [];
      for (const line of priced) {
        baseLines.push((await saleLineBaseAll(env, line)).base);
        const d = Number((await line.get("discount")) ?? 0);
        undiscountedLines.push((await saleLineBaseAll(env, line, { discount: Math.min(d, 0) })).base);
      }
      const grp = (b: unknown) => {
        const st = (b as { special_type?: string | null }).special_type;
        return st !== "global_discount" && st !== "loyalty_discount";
      };
      extendedTaxHelpers.add_tax_details_in_base_lines(baseLines, company);
      extendedTaxHelpers.round_base_lines_tax_details(baseLines, company);
      const agg = extendedTaxHelpers.aggregate_base_lines_aggregated_values(extendedTaxHelpers.aggregate_base_lines_tax_details(baseLines, grp));
      extendedTaxHelpers.add_tax_details_in_base_lines(undiscountedLines, company);
      extendedTaxHelpers.round_base_lines_tax_details(undiscountedLines, company);
      const aggU = extendedTaxHelpers.aggregate_base_lines_aggregated_values(extendedTaxHelpers.aggregate_base_lines_tax_details(undiscountedLines, grp));
      let totalIncl = 0, undiscountedIncl = 0;
      for (const v of Object.values(agg)) totalIncl += v.total_excluded_currency + v.tax_amount_currency;
      for (const v of Object.values(aggU)) if (v.grouping_key) undiscountedIncl += v.total_excluded_currency + v.tax_amount_currency;
      const advIncl = totalIncl - undiscountedIncl;
      if (Math.abs(roundPrecision(advIncl, curRounding)) >= curRounding / 2) {
        basic.lines.push({ label: translate(env, "Total Advantage", "sale"), value: pyFloat(Math.abs(advIncl)) });
      }
    }
    const margin = Number((await rec.get("margin")) ?? 0);
    if (margin) {
      const percent = Number((await rec.get("margin_percent")) ?? 0) * 100;
      // `%(percent).0f` is C's printf: the exact double, a tie to the even integer (12.5 -> "12", 13.5 -> "14")
      basic.lines.push({ label: translate(env, "Margin (%(percent).0f%%)").replace("%(percent).0f%%", `${toFixedHalfEven(percent, 0)}%`), value: pyFloat(margin) });
    }
    return [basic];
  },
});

defineComputes("sale.order", {
  // sale_order.py:518-523 _compute_has_archived_products: an archived product among the lines' products
  has_archived_products: async (env, rec) => {
    const products: number[] = [];
    for (const line of await rec.rels("order_line")) {
      const p = await line.get("product_id");
      if (typeof p === "number" && p) products.push(p);
    }
    if (products.length === 0) return false;
    return (await env.cr.query("SELECT 1 FROM product_product WHERE id = ANY($1::int[]) AND active IS NOT TRUE", [products])).rows.length > 0;
  },
});
/**
 * sale_margin sale_order.py:14-31 _compute_margin (stored): on new orders the sum of the line margins, on saved ones
 * the lines' `_read_group` `margin:sum` (SQL SUM over the numeric column, exact, then a float); the Monetary `margin`
 * rounds to the order's currency when assigned (fields_numeric.py:270-288 convert_to_cache) and `margin_percent`
 * divides that rounded value.
 */
async function orderMargin(env: Environment, rec: Rec): Promise<number> {
  let margin = 0;
  if (rec.id !== null) {
    // `_read_group` flushes the lines' margins first (models.py `_flush_search`): a pending one is computed on access
    for (const line of await rec.rels("order_line")) await line.get("margin");
    margin = (await env.cr.query<{ m: number | null }>("SELECT sum(margin)::float8 AS m FROM sale_order_line WHERE order_id = $1", [rec.id])).rows[0]?.m ?? 0;
  } else {
    for (const line of await rec.rels("order_line")) margin += Number((await line.get("margin")) ?? 0);
  }
  const currency = await rec.get("currency_id");
  if (!margin || typeof currency !== "number") return margin;
  const rounding = (await env.cr.query<{ r: string }>("SELECT rounding::text AS r FROM res_currency WHERE id = $1", [currency])).rows[0]?.r;
  return rounding === undefined ? margin : roundMonetary(margin, Number(rounding));
}
registerRecordCompute("sale.order", {
  margin: async (env, rec) => orderMargin(env, rec),
  margin_percent: async (env, rec) => {
    const untaxed = Number((await rec.get("amount_untaxed")) ?? 0);
    return untaxed ? (await orderMargin(env, rec)) / untaxed : 0;
  },
});

registerRecordCompute("sale.order", {
  // sale_order.py:655-664 _compute_currency_rate (stored) with base res_currency.py `_get_conversion_rate`: 1 between
  // equal currencies, else the company's rates at the order's date (`(date_order or now).date()`, UTC)
  currency_rate: async (env, rec) => {
    const company = await rec.rel("company_id");
    const from = company ? await company.get("currency_id") : null;
    const to = await rec.get("currency_id");
    if ((from || null) === (to || null)) return 1; // `from_currency == to_currency`, empty recordsets included
    if (typeof from !== "number" || typeof to !== "number" || !company) throw new NotPorted("sale.order.currency_rate without a currency");
    const date = await rec.get("date_order");
    const day = typeof date === "string" && date ? date.slice(0, 10)
      : (await env.cr.query<{ d: string }>("SELECT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS d")).rows[0]!.d;
    const { conversionRate } = await import("./currency_convert");
    return conversionRate(env, from, to, company.origin!, day);
  },
});

/** sale_order.py:919-925 _compute_authorized_transaction_ids */
async function authorizedTransactions(_env: Environment, rec: Rec): Promise<number[]> {
  const out: number[] = [];
  for (const t of await rec.rels("transaction_ids")) if ((await t.get("state")) === "authorized" && t.origin !== null) out.push(t.origin);
  return out;
}
defineComputes("sale.order", {
  authorized_transaction_ids: authorizedTransactions,
  has_authorized_transaction_ids: async (env, rec) => (await authorizedTransactions(env, rec)).length > 0,
});

if (!hooksOf("sale.order").displayName) {
  registerHooks("sale.order", {
    // sale_order.py:502-516 _compute_display_name: "<name> (<client ref>)", with the customer under sale_show_partner_name
    displayName: async (env, ids) => {
      const rows = (await env.cr.query<{ id: number; name: string | null; ref: string | null; partner: string | null }>(
        `SELECT o.id, o.name, o.client_order_ref AS ref, p.name AS partner FROM sale_order o LEFT JOIN res_partner p ON p.id = o.partner_id
          WHERE o.id = ANY($1::int[])`, [ids])).rows;
      const out = new Map<number, string>();
      for (const r of rows) {
        let label = r.name ?? "False";
        if (r.ref) label = `${label} (${r.ref})`;
        if (env.context["sale_show_partner_name"] && r.partner) {
          label = env.context["formatted_display_name"] ? `${label} \t --${r.partner}--` : `${label} - ${r.partner}`;
        }
        out.set(r.id, label);
      }
      return out;
    },
  });
}

/** sale_order_line.py:1240-1247 _compute_qty_overage: delivered beyond ordered for prepaid services. */
async function qtyOverage(_env: Environment, line: Rec): Promise<number> {
  const product = await line.rel("product_id");
  if (product && (await product.get("type")) === "service" && (await product.get("invoice_policy")) === "order") {
    return Math.max(Number((await line.get("qty_delivered")) ?? 0) - Number((await line.get("product_uom_qty")) ?? 0), 0);
  }
  return 0;
}
defineComputes("sale.order.line", { qty_overage: qtyOverage });
defineComputes("sale.order", {
  // sale_order.py:1245-1248 _compute_has_overages
  has_overages: async (env, rec) => {
    for (const line of await rec.rels("order_line")) if (await qtyOverage(env, line)) return true;
    return false;
  },
});

/** sale_order.py:791-802 _get_invoiced: the customer invoices and refunds of the lines' invoice lines. */
async function orderInvoices(env: Environment, rec: Rec): Promise<number[]> {
  if (rec.id === null) {
    for (const line of await rec.rels("order_line")) {
      if (((await line.get("invoice_lines")) as unknown[] | null)?.length) throw new NotPorted("sale.order invoices of a new order with invoiced lines");
    }
    return [];
  }
  const ids = [...new Set((await env.cr.query<{ id: number }>(
    `SELECT m.id FROM sale_order_line l JOIN sale_order_line_invoice_rel r ON r.order_line_id = l.id
       JOIN account_move_line aml ON aml.id = r.invoice_line_id JOIN account_move m ON m.id = aml.move_id
      WHERE l.order_id = $1 AND m.move_type IN ('out_invoice', 'out_refund')`, [rec.id])).rows.map((r) => r.id))];
  if (ids.length <= 1 && env.su) return ids;
  // the recordset order of `order_line.invoice_lines.move_id`: the lines in their order (sale_order_line.py:21
  // "order_id, sequence, id"), each line's invoice lines in account.move.line's (account_move_line.py:33 "date desc,
  // move_name desc, id"), the moves by first occurrence. The compute runs as the user (not compute_sudo): both x2many
  // values are filtered by the user's read access (fields_relational.py:692-718 convert_to_record, `_filtered_access`),
  // so an invoice line of another salesperson's invoice is left out (rules account_invoice_line_rule_see_personal)
  const su = env.sudo().withContext({ ...env.context, active_test: false });
  const allLines = await su.model("sale.order.line").search({ kind: "cond", path: "order_id", op: "=", value: rec.id });
  const visibleLines = await filteredAccess(env, "sale.order.line", allLines, "read");
  const amls: number[] = [];
  for (const line of allLines) {
    if (!visibleLines.has(line)) continue;
    const rel = (await env.cr.query<{ id: number }>("SELECT invoice_line_id AS id FROM sale_order_line_invoice_rel WHERE order_line_id = $1", [line])).rows.map((r) => r.id);
    if (!rel.length) continue;
    for (const l of await su.model("account.move.line").search({ kind: "cond", path: "id", op: "in", value: rel })) if (!amls.includes(l)) amls.push(l);
  }
  const visibleAmls = await filteredAccess(env, "account.move.line", amls, "read");
  const moves = new Map((await env.cr.query<{ id: number; m: number }>("SELECT id, move_id AS m FROM account_move_line WHERE id = ANY($1::int[])", [amls])).rows.map((r) => [r.id, r.m]));
  const out: number[] = [];
  for (const l of amls) { const m = moves.get(l)!; if (visibleAmls.has(l) && !out.includes(m)) out.push(m); }
  // `.filtered(lambda r: r.move_type ...)` reads the moves as the user: a move the user may not read raises there
  const readable = await filteredAccess(env, "account.move", out, "read");
  if (out.some((m) => !readable.has(m))) throw new NotPorted("sale.order invoice_ids: an invoice line the user reads on an invoice the user may not read (AccessError)");
  return out.filter((m) => ids.includes(m));
}
/** `order.invoice_ids` read by the environment's user (sale_order.py:792-802), for the methods that use it. */
export async function orderInvoiceIds(env: Environment, order: number): Promise<number[]> {
  return orderInvoices(env, new DbRec(env, env.reg.model("sale.order"), order));
}
defineComputes("sale.order", {
  invoice_ids: orderInvoices,
  invoice_count: async (env, rec) => (await orderInvoices(env, rec)).length,
});

/** decimal.precision `precision_get(name)` (base decimal_precision.py): the digits of the named precision, 2 by default. */
async function precisionGet(env: Environment, name: string): Promise<number> {
  const row = (await env.cr.query<{ digits: number }>("SELECT digits FROM decimal_precision WHERE name = $1", [name])).rows[0];
  return row ? row.digits : 2;
}

/** sale_order_line.py:1249-1254 _compute_invoice_policy */
async function lineInvoicePolicy(env: Environment, line: Rec): Promise<unknown> {
  const product = await line.rel("product_id");
  if (product) return product.get("invoice_policy");
  const company = await line.rel("company_id");
  return company ? company.get("sale_invoice_policy") : null;
}

registerRecordCompute("sale.order.line", {
  // sale_order_line.py:1346-1375 _compute_qty_to_invoice (stored); combo lines refuse
  qty_to_invoice: async (env, line) => {
    if ((await line.get("state")) !== "sale" || (await line.get("display_type"))) return 0;
    const product = await line.rel("product_id");
    if (product && (await product.get("type")) === "combo") throw new NotPorted("sale.order.line.qty_to_invoice of combo lines");
    if (await line.get("combo_item_id")) throw new NotPorted("sale.order.line.qty_to_invoice of combo item lines");
    const invoiced = Number((await line.get("qty_invoiced")) ?? 0);
    const order = await line.rel("order_id");
    const overages = order ? Boolean(await order.get("invoice_overages")) : false;
    if ((await lineInvoicePolicy(env, line)) === "order" && !((await qtyOverage(env, line)) && overages)) {
      return Number((await line.get("product_uom_qty")) ?? 0) - invoiced;
    }
    return Number((await line.get("qty_delivered")) ?? 0) - invoiced;
  },
  // sale_order_line.py:1377-1416 _compute_invoice_status (stored), with sale_stock's override (sale_stock
  // sale_order_line.py:212-237): a confirmed delivered-policy good whose moves are all done or cancelled (one done at
  // least) and something delivered is 'invoiced' rather than 'no' (products sold by weight)
  invoice_status: async (env, line) => {
    const status = await baseLineInvoiceStatus(env, line);
    if (status !== "no" || (await line.get("state")) !== "sale" || !env.reg.models.get("stock.move")?.fields.has("sale_line_id")) return status;
    const product = await line.rel("product_id");
    if (!product || !["consu", "product"].includes(String(await product.get("type"))) || (await product.get("invoice_policy")) !== "delivery") return status;
    if (line.origin === null) throw new NotPorted("sale_stock sale.order.line.invoice_status of a new line (move_ids)");
    const moveRecs = await line.rels("move_ids");
    const states: string[] = [];
    for (const m of moveRecs) states.push(String((await m.get("state")) ?? ""));
    if (!states.length || states.some((s) => s !== "done" && s !== "cancel") || !states.some((s) => s === "done")) return status;
    const digits = await precisionGet(env, "Product Unit");
    if (floatIsZero(Number((await line.get("qty_delivered")) ?? 0), digits)) return status;
    return "invoiced";
  },
});

/** sale_order_line.py:1377-1416 `_compute_invoice_status` of sale itself. */
async function baseLineInvoiceStatus(env: Environment, line: Rec): Promise<string> {
  {
    if ((await line.get("state")) !== "sale") return "no";
    // :1395-1396 a down payment line with nothing left to invoice
    if ((await line.get("is_downpayment")) && Number((await line.get("untaxed_amount_to_invoice")) ?? 0) === 0) return "invoiced";
    const digits = await precisionGet(env, "Product Unit");
    const round = (v: number): number => roundPrecision(v, Number(`1e-${digits}`));
    const qtyToInvoice = Number((await line.get("qty_to_invoice")) ?? 0);
    if (!floatIsZero(qtyToInvoice, digits)) return "to invoice";
    const qty = Number((await line.get("product_uom_qty")) ?? 0), delivered = Number((await line.get("qty_delivered")) ?? 0);
    const invoiced = Number((await line.get("qty_invoiced")) ?? 0);
    const product = await line.rel("product_id");
    const order = await line.rel("order_id");
    const overages = order ? Boolean(await order.get("invoice_overages")) : false;
    if (product && (await product.get("invoice_policy")) === "order" && qty >= 0 && round(delivered) > round(qty)
        && !((await qtyOverage(env, line)) && overages)) return "upselling";
    if (round(invoiced) >= round(qty)) return "invoiced";
    return "no";
  }
}

registerRecordCompute("sale.order.line", {
  // sale_order_line.py:1494-1560 _compute_untaxed_amount_to_invoice (stored): 0 outside the 'sale' state; confirmed
  // lines (invoice lines, included taxes through compute_all) are not ported
  untaxed_amount_to_invoice: async (env, line) => {
    if ((await line.get("state")) !== "sale") return 0;
    const product = await line.rel("product_id");
    const delivery = product ? (await product.get("invoice_policy")) === "delivery" : false;
    const qty = Number((await line.get(delivery ? "qty_delivered" : "product_uom_qty")) ?? 0);
    const discount = Number((await line.get("discount")) ?? 0);
    const reduced = Number((await line.get("price_unit")) ?? 0) * (1 - discount / 100);
    const taxes = (await line.rels("tax_ids")).map((t) => t.origin);
    const included = (await env.cr.query("SELECT 1 FROM account_tax WHERE id = ANY($1::int[]) AND price_include_override = 'tax_included' LIMIT 1", [taxes])).rows.length;
    if (included) throw new NotPorted("sale.order.line.untaxed_amount_to_invoice with included taxes (compute_all)");
    for (const il of await line.rels("invoice_lines")) {
      if (Number((await il.get("discount")) ?? 0) !== discount) throw new NotPorted("sale.order.line.untaxed_amount_to_invoice with another discount on the invoice");
    }
    return reduced * qty - Number((await line.get("untaxed_amount_invoiced")) ?? 0);
  },
});

/** sale_order.py:927-933 _compute_amount_paid: authorized or done transactions. */
async function amountPaid(_env: Environment, rec: Rec): Promise<number> {
  let paid = 0;
  for (const tx of await rec.rels("transaction_ids")) {
    const state = await tx.get("state");
    if (state === "authorized" || state === "done") paid += Number((await tx.get("amount")) ?? 0);
  }
  return paid;
}
defineComputes("sale.order", { amount_paid: amountPaid });
registerRecordCompute("sale.order", {
  // sale_order.py:935-953 _compute_amount_unpaid (stored): orders without transactions or invoice lines
  amount_unpaid: async (env, rec) => {
    if ((await rec.rels("transaction_ids")).length) throw new NotPorted("sale.order.amount_unpaid with payment transactions");
    // the offline invoice lines: math.copysign(line.price_total, -line.balance) of draft and posted invoices
    let offline = 0;
    for (const line of await rec.rels("order_line")) {
      for (const il of await line.rels("invoice_lines")) {
        if (!["draft", "posted"].includes(String(await il.get("parent_state")))) continue;
        const total = Math.abs(Number((await il.get("price_total")) ?? 0)), balance = Number((await il.get("balance")) ?? 0);
        offline += -balance < 0 || Object.is(-balance, -0) ? -total : total;
      }
    }
    return Math.max(Number((await rec.get("amount_total")) ?? 0) - (await amountPaid(env, rec)) - offline, 0);
  },
});

/** sale_pdf_quote_builder sale_order.py:39-56 _compute_available_quotation_document_ids. */
async function availableQuotationDocuments(env: Environment, rec: Rec): Promise<number[]> {
  const company = await rec.get("company_id");
  const domain = typeof company === "number" && company ? cond("company_id", "in", [company, false]) : cond("company_id", "=", false);
  const docs = await env.model("quotation.document").search(domain, { order: "sequence" });
  if (docs.length === 0) return [];
  const template = await rec.get("sale_order_template_id");
  const links = (await env.cr.query<{ doc: number; tmpl: number }>(
    "SELECT quotation_document_id AS doc, sale_order_template_id AS tmpl FROM header_footer_quotation_template_rel WHERE quotation_document_id = ANY($1::int[])", [docs])).rows;
  return docs.filter((d) => {
    const templates = links.filter((l) => l.doc === d).map((l) => l.tmpl);
    return templates.length === 0 || (typeof template === "number" && templates.includes(template));
  });
}
defineComputes("sale.order", {
  available_quotation_document_ids: availableQuotationDocuments,
  // sale_order.py:58-68 _compute_is_pdf_quote_builder_available (the lines' product documents: sale_order_line.py:40-60)
  is_pdf_quote_builder_available: async (env, rec) => {
    if ((await availableQuotationDocuments(env, rec)).length) return true;
    const products: number[] = [], templates: number[] = [];
    for (const line of await rec.rels("order_line")) {
      const p = await line.get("product_id"), t = await line.get("product_template_id");
      if (typeof p === "number" && p) products.push(p);
      if (typeof t === "number" && t) templates.push(t);
    }
    if (products.length === 0 && templates.length === 0) return false;
    const n = (await env.cr.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM product_document d JOIN ir_attachment a ON a.id = d.ir_attachment_id
        WHERE a.type = 'binary' AND a.file_size > 0 AND a.mimetype = 'application/pdf'
          AND ((a.res_model = 'product.product' AND a.res_id = ANY($1::int[])) OR (a.res_model = 'product.template' AND a.res_id = ANY($2::int[])))`,
      [products, templates])).rows[0]?.n ?? "0";
    if (Number(n) > 0) throw new NotPorted("sale.order.line available product documents (attached_on_sale rules)");
    return false;
  },
});

defineComputes("sale.order", {
  // sale_project sale_order.py:67-70 _compute_is_product_milestone: a line product invoiced on milestones
  is_product_milestone: async (_env, rec) => {
    for (const line of await rec.rels("order_line")) {
      const product = await line.rel("product_id");
      if (product && (await product.get("service_policy")) === "delivered_milestones") return true;
    }
    return false;
  },
});

/** sale_stock sale_order.py:183-196 _compute_json_popover: the late pickings (delay_alert_date). */
async function latePickings(_env: Environment, rec: Rec): Promise<{ id: number; name: string }[]> {
  const out: { id: number; name: string }[] = [];
  for (const p of await rec.rels("picking_ids")) {
    if (p.origin !== null && (await p.get("delay_alert_date"))) out.push({ id: p.origin, name: String((await p.get("display_name")) || "") });
  }
  return out;
}
defineComputes("sale.order", {
  json_popover: async (env, rec) => {
    const late = await latePickings(env, rec);
    // json.dumps with the default separators (", ", ": ") and ensure_ascii
    const ascii = (s: string): string => JSON.stringify(s).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
    const items = late.map((l) => `{"id": ${l.id}, "name": ${ascii(l.name)}, "model": "stock.picking"}`).join(", ");
    return `{"popoverTemplate": "sale_stock.DelayAlertWidget", "late_elements": [${items}]}`;
  },
  show_json_popover: async (env, rec) => (await latePickings(env, rec)).length > 0,
});

/** sale_management sale_order_line.py:79-89 _is_line_optional */
async function lineIsOptional(line: Rec): Promise<boolean> {
  const parent = await line.rel("parent_id");
  if (!parent) return false;
  if (await parent.get("is_optional")) return true;
  if ((await parent.get("display_type")) !== "line_subsection") return false;
  const grand = await parent.rel("parent_id");
  return grand ? Boolean(await grand.get("is_optional")) : false;
}

/** sale_project sale_order.py:129-145 _compute_project_ids: projects of the order and of its service lines (readable). */
async function orderProjects(env: Environment, rec: Rec): Promise<number[]> {
  const out: number[] = [];
  const add = (v: unknown): void => { if (typeof v === "number" && v && !out.includes(v)) out.push(v); };
  for (const line of await rec.rels("order_line")) {
    if (!(await line.get("is_service"))) continue;
    if ((await lineIsOptional(line)) && Number((await line.get("product_uom_qty")) ?? 0) === 0) continue;
    const product = await line.rel("product_id");
    if (product) add(await product.get("project_id"));
  }
  add(await rec.get("project_id"));
  for (const line of await rec.rels("order_line")) add(await line.get("project_id"));
  if (rec.origin !== null) {
    for (const p of await env.model("project.project").search(or([cond("sale_order_id", "in", [rec.origin]), cond("reinvoiced_sale_order_id", "in", [rec.origin])]))) add(p);
  }
  if (out.length === 0) return [];
  const readable = await filteredAccessIds(env, "project.project", out);
  return out.filter((p) => readable.has(p));
}
/** `len(projects.filtered('active'))` */
async function activeProjectCount(env: Environment, ids: number[]): Promise<number> {
  if (ids.length === 0) return 0;
  return Number((await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM project_project WHERE id = ANY($1::int[]) AND active", [ids])).rows[0]?.n ?? 0);
}
async function filteredAccessIds(env: Environment, model: string, ids: number[]): Promise<Set<number>> {
  const { filteredAccess } = await import("./tail_util");
  return filteredAccess(env, model, ids, "read");
}

defineComputes("sale.order", {
  // sale_project sale_order.py:58-66 _compute_milestone_count
  milestone_count: async (env, rec) => {
    const lines: number[] = [];
    for (const l of await rec.rels("order_line")) if (l.origin !== null) lines.push(l.origin);
    if (lines.length === 0) return 0;
    return env.model("project.milestone").searchCount(cond("sale_line_id", "in", lines));
  },
  // sale_order.py:538-541 _compute_prepayment_amount
  prepayment_amount: async (_env, rec) => Number((await rec.get("prepayment_percent")) ?? 0) * Number((await rec.get("amount_total")) ?? 0),
  // sale_order.py:804-810 _compute_transaction_count
  transaction_count: async (env, rec) => ((await hasGroup(env, "account.group_account_invoice")) ? (await rec.rels("transaction_ids")).length : 0),
  // sale_order.py:1160-1174 _compute_partner_credit_warning
  partner_credit_warning: async (_env, rec) => {
    const state = await rec.get("state");
    const company = await rec.rel("company_id");
    if ((state === "draft" || state === "sent") && company && (await company.get("account_use_credit_limit"))) {
      throw new NotPorted("sale.order.partner_credit_warning with credit limits (_build_credit_warning_message)");
    }
    return "";
  },
  // sale_order.py:1222-1239 _compute_sale_warning_text
  sale_warning_text: async (env, rec) => {
    if (!(await hasGroup(env, "sale.group_warning_sale"))) return "";
    throw new NotPorted("sale.order.sale_warning_text with the warning group");
  },
  // sale_purchase sale_order.py:16-18, 54-55 with sale_purchase_stock sale_order.py:9-17
  purchase_order_count: async (env, rec) => {
    const orders = new Set<number>();
    for (const ref of await rec.rels("stock_reference_ids")) {
      for (const po of await ref.rels("purchase_ids")) if (po.origin !== null) orders.add(po.origin);
    }
    for (const line of await rec.rels("order_line")) {
      for (const pl of await line.rels("purchase_line_ids")) { const o = await pl.get("order_id"); if (typeof o === "number") orders.add(o); }
    }
    return orders.size;
  },
  // sale_project sale_order.py:40-56 _compute_project_required
  project_required: async (_env, rec) => {
    const lines = await rec.rels("order_line");
    const tracking = async (l: Rec): Promise<unknown> => { const p = await l.rel("product_id"); return p ? p.get("service_tracking") : null; };
    for (const l of lines) { const t = await tracking(l); if (t === "project_only" || t === "task_in_project") return false; }
    for (const l of lines) {
      if ((await tracking(l)) !== "task_global_project" || (await l.get("task_id"))) continue;
      const p = await l.rel("product_id");
      if (!(p && (await p.get("project_id")))) return true;
    }
    return false;
  },
  project_ids: orderProjects,
  project_count: async (env, rec) => activeProjectCount(env, await orderProjects(env, rec)),
  // sale_project sale_order.py:72-76 _compute_show_project_and_task_button
  show_project_button: async (env, rec) => (await activeProjectCount(env, await orderProjects(env, rec))) > 0,
  show_create_project_button: async (env) => hasGroup(env, "project.group_project_manager"),
  // sale_project sale_order.py:92-118 _compute_tasks_ids: the `_read_group` by (sale_order_id, state) of the tasks,
  // each group's ids in order
  tasks_ids: async (env, rec) => {
    if (rec.origin === null) return [];
    const lines: number[] = [];
    for (const l of await rec.rels("order_line")) if (l.origin !== null) lines.push(l.origin);
    const tasks = await env.model("project.task").search(and([cond("is_template", "=", false), cond("project_id", "!=", false),
      or([cond("sale_line_id", "in", lines), cond("sale_order_id", "in", [rec.origin])]), cond("has_template_ancestor", "=", false)]));
    if (tasks.length === 0) return [];
    const rows = (await env.cr.query<{ id: number; so: number | null; state: string | null }>(
      "SELECT id, sale_order_id AS so, state FROM project_task WHERE id = ANY($1::int[]) ORDER BY state, id", [tasks])).rows;
    if (rows.some((r) => r.so !== rec.origin)) throw new NotPorted("sale.order.tasks_ids with tasks of other orders or without sale order");
    return rows.map((r) => r.id);
  },
  tasks_count: async (env, rec) => {
    if (rec.origin === null) return 0;
    const lines: number[] = [];
    for (const l of await rec.rels("order_line")) if (l.origin !== null) lines.push(l.origin);
    const tasks = await env.model("project.task").search(and([cond("is_template", "=", false), cond("project_id", "!=", false),
      or([cond("sale_line_id", "in", lines), cond("sale_order_id", "in", [rec.origin])]), cond("has_template_ancestor", "=", false)]));
    if (tasks.length === 0) return 0;
    const own = (await env.cr.query<{ n: string }>("SELECT count(*)::text AS n FROM project_task WHERE id = ANY($1::int[]) AND sale_order_id = $2", [tasks, rec.origin])).rows[0]?.n ?? "0";
    if (Number(own) !== tasks.length) throw new NotPorted("sale.order.tasks_count with tasks of other orders or without sale order");
    return tasks.length;
  },
});

defineComputes("sale.order.line", {
  // sale_order_line.py:488-491 _compute_is_product_archived
  is_product_archived: async (_env, line) => {
    const product = await line.rel("product_id");
    return product ? !(await product.get("active")) : false;
  },
  // sale_order_line.py:1686-1705 _compute_parent_id: the last section/subsection above the line, by sequence
  parent_id: async (env, line) => {
    if (line.id === null) return newLineParent(line);
    const order = await line.get("order_id");
    if (typeof order !== "number" || !order) return null;
    const rows = (await env.cr.query<{ id: number; display_type: string | null }>(
      "SELECT id, display_type FROM sale_order_line WHERE order_id = $1 ORDER BY sequence, id", [order])).rows;
    let section: number | null = null, sub: number | null = null;
    for (const r of rows) {
      if (r.display_type === "line_section") { if (r.id === line.id) return null; section = r.id; sub = null; }
      else if (r.display_type === "line_subsection") { if (r.id === line.id) return section; sub = r.id; }
      else if (r.id === line.id) return sub ?? section;
    }
    return null;
  },
});

/**
 * `_compute_parent_id` of a line in an onchange: the walk over `order.order_line.sorted("sequence")` of the order's
 * cache (its new lines among them, in the order of the onchange's commands; `sorted` is stable on equal sequences).
 * A line is the one computed when it is the same new record, or a record of the same database id.
 */
async function newLineParent(line: Rec): Promise<number | Rec | null> {
  const order = await line.rel("order_id");
  if (!order) return null;
  const lines = await order.rels("order_line");
  const keyed: { rec: Rec; seq: number; i: number }[] = [];
  for (const [i, rec] of lines.entries()) keyed.push({ rec, seq: Number((await rec.get("sequence")) ?? 0), i });
  keyed.sort((a, b) => a.seq - b.seq || a.i - b.i);
  const same = (r: Rec) => r === line || (line.origin !== null && r.origin === line.origin);
  const asValue = (r: Rec | null) => (r === null ? null : r.id !== null ? r.id : r);
  let section: Rec | null = null, sub: Rec | null = null;
  for (const { rec } of keyed) {
    const kind = await rec.get("display_type");
    if (kind === "line_section") { if (same(rec)) return null; section = rec; sub = null; }
    else if (kind === "line_subsection") { if (same(rec)) return asValue(section); sub = rec; }
    else if (same(rec)) return asValue(sub ?? section);
  }
  // not among its order's lines: Python assigns nothing and the field keeps its cache
  throw new NotPorted("sale.order.line.parent_id of a line outside its order's order_line");
}

defineComputes("sale.order.line", {
  // sale_order_line.py:1706-1710 _compute_mandatory_product: get_bool('sale.mandatory_product')
  mandatory_product: async (env) => {
    const v = await configParam(env, "sale.mandatory_product");
    return v === null ? false : str2bool(v, false);
  },
  // sale_order_line.py:1666-1678, then sale_stock sale_order_line.py:258-263 (non-cancelled moves) and sale_project
  // sale_order_line.py:66-71 (confirmed services): each override only clears the flag
  product_updatable: async (env, line) => {
    if ((env.reg.model("sale.order.line").modules ?? []).includes("stock_dropshipping")) throw new NotPorted("stock_dropshipping product_updatable");
    const state = await line.get("state");
    if (await line.get("is_downpayment") || state === "cancel") return false;
    const order = await line.rel("order_id");
    if (state === "sale" && ((order && await order.get("locked")) || Number((await line.get("qty_invoiced")) ?? 0) > 0 || Number((await line.get("qty_delivered")) ?? 0) > 0)) return false;
    for (const m of await line.rels("move_ids")) if ((await m.get("state")) !== "cancel") return false;
    const product = await line.rel("product_id");
    if (product && (await product.get("type")) === "service" && state === "sale") return false;
    return true;
  },
});

defineComputes("sale.order", {
  // sale_order.py:1142-1148 _compute_tax_country_id: the foreign-VAT fiscal position's country, else the company's
  tax_country_id: async (_env, rec) => {
    const fpos = await rec.rel("fiscal_position_id");
    if (fpos && (await fpos.get("foreign_vat"))) return (await fpos.get("country_id")) || null;
    const company = await rec.rel("company_id");
    return company ? (await company.get("account_fiscal_country_id")) || null : null;
  },
});

registerOverrides("sale.order", {
  inverse: {
    // sale_order.py:583-586 _inverse_note with account_move.py:4129-4142 _set_links_to_new_tab: a non-string note is
    // kept as is; an HTML note is re-serialized by lxml with target="_blank" links (not ported)
    note: async (env, ids) => {
      for (const id of ids) {
        const note = (await env.cr.query<{ note: unknown }>("SELECT note FROM sale_order WHERE id = $1", [id])).rows[0]?.note;
        const text = typeof note === "string" ? note : note && typeof note === "object" ? Object.values(note as Record<string, unknown>)[0] : null;
        // one element with plain text and quoted attributes comes back from lxml byte for byte
        if (typeof text === "string" && text !== "" && !/^<(div|p)( [a-z-]+="[^"<>&]*")*>[^<>&]*<\/\1>$/.test(text)) {
          throw new NotPorted("sale.order note inverse (lxml re-serialization in _set_links_to_new_tab)");
        }
      }
    },
    // sale_order.py:543-548 _inverse_prepayment_amount
    prepayment_amount: async (env, ids) => {
      for (const id of ids) {
        const rec = new DbRec(env, env.reg.model("sale.order"), id);
        const total = Number((await rec.get("amount_total")) ?? 0);
        const amount = Number((await rec.get("prepayment_amount")) ?? 0);
        await write(env, "sale.order", [id], { prepayment_percent: total ? amount / total : 0 });
      }
    },
  },
});

registerRecordCompute("sale.order", {
  // sale_order.py:502-516 _compute_display_name on new records
  display_name: async (env, rec) => {
    if (rec.id !== null) return (await env.model("sale.order").displayName([rec.id])).get(rec.id) ?? "";
    const name = await rec.get("name");
    let label = typeof name === "string" && name ? name : "False";
    const ref = await rec.get("client_order_ref");
    if (ref) label = `${label} (${String(ref)})`;
    const partner = await rec.rel("partner_id");
    const pname = partner ? await partner.get("name") : null;
    if (env.context["sale_show_partner_name"] && pname) {
      label = env.context["formatted_display_name"] ? `${label} \t --${String(pname)}--` : `${label} - ${String(pname)}`;
    }
    return label;
  },
});

// sale_order.py:85-94 `state = fields.Selection(..., group_expand=True)`: fields_selection.py:91-93 and :214-216
// `_default_group_expand`, a group per option in definition order (`get_values`, the keys), with read_group_expand
registerGroupExpand("sale.order", "state", async (env) => (env.reg.model("sale.order").fields.get("state")?.selection ?? []).map((s) => s.value));
