/**
 * product.* non-stored computes, search methods and callable selections (odoo/addons/product/models/ and the
 * installed overrides: sale_project). Each body cites its source.
 */
import { imageReadFirst, isImageSizeAbove, withImageWriteOrder } from "../orm/image_write";
import { registerOverrides, write } from "../orm/write";
import { NotPorted, ValidationError } from "../errors";
import { and, cond, isNegativeOperator, or } from "../orm/domain";
import { hasGroup } from "../orm/env";
import { hooksOf, registerHooks } from "../orm/hooks";
import { DbRec, DELEGATE_PARENT_MODELS, NewRec, NOT_ASSIGNED, type Rec, registerDefaults, registerOnchange, registerRecordCompute } from "../orm/recompute";
import type { BinaryValue, Domain, Environment } from "../orm/types";
import { binaryBytes } from "./binary";
import { sql, type Sql, type Table } from "../orm/sql";
import { registerActivityMixin } from "./crm_activity";
import { configParam, defineComputes, getLang, registerDefaultValued, searchMethod } from "./tail_util";
import { pyFloatReprSimple, translate } from "./util";

defineComputes("product.category", {
  // product_category.py:34-41 _compute_complete_name: "<parent complete_name> / <name>" or the name
  complete_name: async (_env, rec) => {
    const parent = await rec.rel("parent_id");
    const name = await rec.get("name");
    // '%s / %s' % (parent.complete_name, name): a falsy value prints as Python's False
    const py = (v: unknown): string => (v === false || v === null || v === undefined || v === "" ? (v === "" ? "" : "False") : String(v));
    if (parent) return `${py(await parent.get("complete_name"))} / ${py(name)}`;
    return name;
  },
});
registerHooks("product.category", {
  search: {
    // product_category.py:43-54 _search_complete_name
    complete_name: searchMethod("product.category", "complete_name", async (env, operator, value) => {
      if (isNegativeOperator(operator)) return null;
      if (env.context["import_file"]) throw new NotPorted("product.category.complete_name search during import");
      const ids = await env.model("product.category").search(cond("name", operator, value));
      return or([cond("name", operator, value), cond("id", "child_of", ids)]);
    }),
  },
});

defineComputes("product.attribute", {
  // product_attribute.py:73-82 _compute_number_related_products: _read_group of the attribute lines (as the user)
  // with an active template, counted per attribute
  number_related_products: async (env, rec) => {
    if (rec.id === null) return 0;
    const lines = await env.model("product.template.attribute.line").search(and([cond("attribute_id", "in", [rec.id]), cond("product_tmpl_id.active", "=", true)]));
    return lines.length;
  },
  // product_attribute.py:86-97 _compute_products (stored): the templates of the attribute's lines, a `_read_group` of
  // product.template.attribute.line (active lines: the record's context), assigned `with_context(active_test=False)`
  product_tmpl_ids: async (env, rec) => {
    if (rec.id === null) {
      if (rec.origin !== null) throw new NotPorted("product.attribute._compute_products of an edited attribute");
      return [];
    }
    const ids = await env.model("product.template.attribute.line").search(cond("attribute_id", "in", [rec.id]));
    if (!ids.length) return [];
    const rows = (await env.cr.query<{ t: number }>("SELECT DISTINCT product_tmpl_id AS t FROM product_template_attribute_line WHERE id = ANY($1::int[]) ORDER BY 1", [ids])).rows;
    return rows.map((r) => r.t);
  },
});

/**
 * product.document search_count of a document domain as the user; sale_gelato (product_template.py:213-215,
 * installed when product.document has is_gelato) narrows the template domain to non-gelato documents.
 */
async function productDocumentCount(env: Environment, tmplIds: number[], variantIds: number[], gelato: boolean): Promise<number> {
  let domain = or([
    and([cond("res_model", "=", "product.template"), cond("res_id", "in", tmplIds)]),
    and([cond("res_model", "=", "product.product"), cond("res_id", "in", variantIds)]),
  ]);
  if (gelato && env.reg.model("product.document").fields.has("is_gelato")) domain = and([domain, cond("is_gelato", "=", false)]);
  return env.model("product.document").searchCount(domain);
}
defineComputes("product.template", {
  // product_template.py:276-280 _compute_product_document_count with _get_product_document_domain
  // (product_template.py:1831-1834): the template's documents and its variants' documents
  product_document_count: async (env, rec) => {
    if (rec.id === null) return 0;
    const variants = (await rec.rels("product_variant_ids")).map((v) => v.id).filter((id): id is number => id !== null);
    return productDocumentCount(env, [rec.id], variants, true);
  },
});
defineComputes("product.product", {
  // product_product.py:554-567 _compute_product_document_count: the variant's documents and its template's
  product_document_count: async (env, rec) => {
    const tmpl = await rec.get("product_tmpl_id");
    return productDocumentCount(env, typeof tmpl === "number" ? [tmpl] : [], rec.id === null ? [] : [rec.id], false);
  },
});

defineComputes("product.template", {
  // product_template.py:620-624 _compute_product_variant_count: len(product_variant_ids)
  product_variant_count: async (_env, rec) => (await rec.rels("product_variant_ids")).length,
  // product_template.py:404-409 _compute_cost_currency_id: the company's currency, else env.company's
  cost_currency_id: async (env, rec) => {
    const company = await rec.get("company_id");
    const currencyOf = async (id: number): Promise<number | null> =>
      (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [id])).rows[0]?.currency_id ?? null;
    if (typeof company === "number") {
      const c = await currencyOf(company);
      if (c) return c;
    }
    return currencyOf(await env.company());
  },
});

defineComputes("product.template", {
  // product_template.py:657-669 _compute_product_tooltip / _prepare_tooltip, extended by sale product_template.py:78-101
  // (invoicing and service-tracking parts), sale_project :66-89, sale_timesheet :47-50 and sale_purchase :42-45
  // when those modules extend product.template; the conditions of the extensions are disjoint, so their MRO order
  // does not matter
  product_tooltip: async (env, rec) => {
    const modules = env.reg.model("product.template").modules ?? [];
    for (const m of ["event_sale", "event_booth_sale", "website_sale_slides"]) {
      if (modules.includes(m)) throw new NotPorted(`product.template.product_tooltip with ${m}`);
    }
    const type = await rec.get("type");
    let tooltip = type === "combo" ? translate(env, "Combos allow to choose one product amongst a selection of choices per category.") : "";
    if (!modules.includes("sale") || !(await rec.get("sale_ok"))) return tooltip;
    const policy = modules.includes("sale_project") ? await rec.get("service_policy") : null;
    const invoicePolicy = await rec.get("invoice_policy");
    let invoicing = "";
    if (modules.includes("sale_timesheet") && policy === "delivered_timesheet") invoicing = translate(env, "Invoice based on timesheets (delivered quantity).");
    else if (modules.includes("sale_project") && policy === "delivered_milestones") invoicing = translate(env, "Invoice your milestones when they are reached.");
    else if (invoicePolicy === "delivery" && type !== "consu") invoicing = translate(env, "Invoice after delivery, based on quantities delivered, not ordered.");
    else if (invoicePolicy === "order" && type === "service") invoicing = translate(env, "Invoice ordered quantities as soon as this service is sold.");
    tooltip = tooltip ? `${tooltip} ${invoicing}` : invoicing;
    if (type === "service") {
      const tracking = await rec.get("service_tracking");
      let extra = "";
      if (modules.includes("sale_project")) {
        if (tracking === "task_global_project") extra = translate(env, "Create a task in an existing project to track the time spent.");
        else if (tracking === "project_only") extra = translate(env, "Create an empty project for the order to track the time spent.");
        else if (tracking === "task_in_project") extra = translate(env, "Create a project for the order with a task for each sales order line to track the time spent.");
        else if (tracking === "no") extra = translate(env, "Create projects or tasks later, and link them to order to track the time spent.");
      }
      if (!extra && modules.includes("sale_purchase") && tracking === "subcontract") {
        extra = translate(env, "Each time you sell this product through a SO, a RfQ is automatically created to buy the product. Tip: don't forget to set a vendor on the product.");
      }
      if (extra) tooltip = tooltip ? `${tooltip} ${extra}` : extra;
    }
    return tooltip;
  },
});

/** sale_project product_template.py:10-20 `_selection_service_policy` (sale_timesheet :12-15 when installed). */
async function serviceSelection(env: Environment): Promise<readonly [string, string][]> {
  const modules = env.reg.model("product.template").modules ?? [];
  if (!modules.includes("sale_project")) throw new NotPorted("product.template.service_policy without sale_project");
  const out: [string, string][] = [
    // `_()` of sale_project's module (rådet runda 13: without the module a French write refused here)
    ["ordered_prepaid", translate(env, "Prepaid/Fixed Price", "sale_project")],
    ["delivered_manual", translate(env, "Based on Delivery (Manual)", "sale_project")],
  ];
  // res_groups.py:574 _is_feature_enabled: the superuser has the group
  if (await hasGroup(env.withUser(1), "project.group_project_milestone")) out.splice(1, 0, ["delivered_milestones", translate(env, "Based on Milestones", "sale_project")]);
  if (modules.includes("sale_timesheet")) out.splice(1, 0, ["delivered_timesheet", translate(env, "Based on Timesheets", "sale_timesheet")]);
  return out;
}
registerHooks("product.template", { selection: { service_policy: serviceSelection } });
registerHooks("product.product", { selection: { service_policy: serviceSelection } });

// mail.activity.mixin computes (mail_activity_mixin.py:134-230) of the product models inheriting it
for (const model of ["product.template", "product.product", "product.pricelist"]) registerActivityMixin(model);

/** account product.py:83/:90: `env.companies.<field> or env.companies.root_id.sudo().<field>` (mapped, first occurrences). */
async function companyTaxes(env: Environment, field: "account_sale_tax_id" | "account_purchase_tax_id"): Promise<unknown> {
  const companies = await env.companies();
  const rows = new Map((await env.cr.query<{ id: number; tax: number | null; parent_path: string | null }>(
    `SELECT id, ${field} AS tax, parent_path FROM res_company WHERE id = ANY($1::int[])`, [companies])).rows.map((r) => [r.id, r]));
  const pick = (ids: readonly number[]): number[] => {
    const out: number[] = [];
    for (const id of ids) { const t = rows.get(id)?.tax; if (t && !out.includes(t)) out.push(t); }
    return out;
  };
  let taxes = pick(companies);
  if (taxes.length === 0) {
    // res_company.py:186-192 root_id = parent_ids[0] (the first id of parent_path)
    const roots: number[] = [];
    for (const id of companies) {
      const root = Number((rows.get(id)?.parent_path ?? "").split("/")[0]);
      if (root && !roots.includes(root)) roots.push(root);
    }
    const missing = roots.filter((r) => !rows.has(r));
    if (missing.length) {
      for (const r of (await env.cr.query<{ id: number; tax: number | null; parent_path: string | null }>(
        `SELECT id, ${field} AS tax, parent_path FROM res_company WHERE id = ANY($1::int[])`, [missing])).rows) rows.set(r.id, r);
    }
    taxes = pick(roots);
  }
  return [[6, 0, taxes]];
}

registerDefaults("product.template", {
  taxes_id: (env) => companyTaxes(env, "account_sale_tax_id"),
  supplier_taxes_id: (env) => companyTaxes(env, "account_purchase_tax_id"),
  // stock product.py:869: bool(search_count of the selectable routes)
  has_available_route_ids: async (env) => (await env.model("stock.route").searchCount(cond("product_selectable", "=", true))) > 0,
  // stock product.py:820-822 _default_responsible_id: the user unless the superuser
  responsible_id: async (env) => (env.uid === 1 ? false : env.uid),
  // product_template.py:35-38 _default_uom_id
  uom_id: async (env) => {
    const id = await env.reg.xmlid(env.cr, "uom.product_uom_unit");
    if (id === null) throw new NotPorted("product.template default uom (missing uom.product_uom_unit)");
    return id;
  },
});

registerDefaults("product.supplierinfo", {
  // product_supplierinfo.py:36, :39
  company_id: async (env) => env.company(),
  currency_id: async (env) => (await env.cr.query<{ currency_id: number | null }>(
    "SELECT currency_id FROM res_company WHERE id = $1", [await env.company()])).rows[0]?.currency_id ?? false,
});

registerHooks("product.product", {
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the ones registered before
  descriptionDomain: {
    ...hooksOf("product.product").descriptionDomain,
    // the delegated product.template field (product_template.py:49-51, 208-211 `_domain_fixed_pricelist_rule_ids`)
    fixed_pricelist_rule_ids: async (env) => {
      const f = env.reg.model("product.template").fields.get("fixed_pricelist_rule_ids");
      if (!f || f.domainCallable || f.descriptionDomain === undefined) throw new NotPorted("product.template.fixed_pricelist_rule_ids description domain");
      return f.descriptionDomain;
    },
  },
});

/** Recordset union `a | b`: first occurrences, in order. */
function unionIds(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])];
}
const idsOf = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : []);
/** stock product.py:1308-1316 _compute_parent_route_ids: the ancestors' routes, minus the category's own. */
async function parentRouteIds(rec: Rec): Promise<number[]> {
  let routes: number[] = [];
  let base = rec;
  for (let parent = await base.rel("parent_id"); parent; parent = await base.rel("parent_id")) {
    base = parent;
    routes = unionIds(routes, idsOf(await base.get("route_ids")));
  }
  const own = new Set(idsOf(await rec.get("route_ids")));
  return routes.filter((r) => !own.has(r));
}
defineComputes("product.category", {
  parent_route_ids: async (_env, rec) => parentRouteIds(rec),
  // stock product.py:1323-1327 _compute_total_route_ids
  total_route_ids: async (_env, rec) => unionIds(idsOf(await rec.get("route_ids")), await parentRouteIds(rec)),
});

defineComputes("product.category", {
  // product_category.py:56-64 _compute_product_count: templates (as the user) in each child category
  product_count: async (env, rec) => {
    if (rec.id === null) return 0;
    const categs = await env.model("product.category").search(cond("id", "child_of", [rec.id]));
    if (categs.length === 0) return 0;
    const templates = await env.model("product.template").search(cond("categ_id", "child_of", [rec.id]));
    if (templates.length === 0) return 0;
    const rows = (await env.cr.query<{ categ_id: number; n: string }>(
      "SELECT categ_id, count(*)::text AS n FROM product_template WHERE id = ANY($1::int[]) GROUP BY categ_id", [templates])).rows;
    const byCateg = new Map(rows.map((r) => [r.categ_id, Number(r.n)]));
    return categs.reduce((sum, c) => sum + (byCateg.get(c) ?? 0), 0);
  },
});

defineComputes("product.attribute.value", {
  // product_attribute_value.py:75-78 _compute_is_used_on_products: a line whose template is active
  is_used_on_products: async (_env, rec) => {
    for (const line of await rec.rels("pav_attribute_line_ids")) {
      const tmpl = await line.rel("product_tmpl_id");
      if (tmpl && await tmpl.get("active")) return true;
    }
    return false;
  },
  // product_attribute_value.py:80-94 _compute_default_extra_price_changed (ptavs searched as superuser on the
  // templates of env.companies, models.py:3339 _check_company_domain)
  default_extra_price_changed: async (env, rec) => {
    const price = Number((await rec.get("default_extra_price")) ?? 0);
    if (rec.origin === null) {
      if (price !== 0) return true; // `_origin.default_extra_price` of a new record is 0.0
      return false;
    }
    const originPrice = Number((await env.cr.query<{ p: number | null }>(
      "SELECT default_extra_price AS p FROM product_attribute_value WHERE id = $1", [rec.origin])).rows[0]?.p ?? 0);
    if (price !== originPrice) return true;
    const ptavs = await env.sudo().model("product.template.attribute.value").search(and([
      cond("product_attribute_value_id", "in", [rec.origin]),
      cond("product_tmpl_id", "any", cond("company_id", "in", [...await env.companies(), false])),
    ]));
    if (ptavs.length === 0) return false;
    const rows = (await env.cr.query<{ p: number | null }>(
      "SELECT price_extra AS p FROM product_template_attribute_value WHERE id = ANY($1::int[])", [ptavs])).rows;
    return rows.some((r) => Number(r.p ?? 0) !== price);
  },
});

/** res_company.py:475-481 _get_main_company: base.main_company, else the first company by id. */
export async function mainCompanyCurrency(env: Environment): Promise<number | null> {
  let company = await env.reg.xmlid(env.cr, "base.main_company");
  if (company === null) company = (await env.cr.query<{ id: number }>("SELECT id FROM res_company ORDER BY id LIMIT 1")).rows[0]?.id ?? null;
  if (company === null) return null;
  return (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [company])).rows[0]?.currency_id ?? null;
}

defineComputes("product.template", {
  // product_template.py:395-398 _compute_currency_id (compute_sudo): the company's currency, else the main company's
  currency_id: async (env, rec) => {
    const company = await rec.get("company_id");
    if (typeof company === "number" && company) {
      const c = (await env.cr.query<{ currency_id: number | null }>("SELECT currency_id FROM res_company WHERE id = $1", [company])).rows[0]?.currency_id;
      if (c) return c;
    }
    return mainCompanyCurrency(env);
  },
});
registerHooks("product.template", {
  computeSql: {
    // product_template.py:400-402 _compute_sql_currency_id: COALESCE(company currency, main company currency)
    currency_id: async (table: Table): Promise<Sql> => {
      const main = await mainCompanyCurrency(table.env);
      return sql`COALESCE((SELECT c.currency_id FROM res_company c WHERE c.id = ${await table.field("company_id")}), ${main}::int)`;
    },
  },
});

/** sale_project product_template.py:91-97 `_get_service_to_general_map` (sale_timesheet is not installed). */
const SERVICE_TO_GENERAL: readonly [string, string, string][] = [
  ["ordered_prepaid", "order", "manual"], ["delivered_milestones", "delivery", "milestones"], ["delivered_manual", "delivery", "manual"]];

defineComputes("product.template", {
  // sale_project product_template.py:49-54 _compute_service_policy (compute_sudo)
  service_policy: async (env, rec) => {
    if ((env.reg.model("product.template").modules ?? []).includes("sale_timesheet")) throw new NotPorted("product.template.service_policy with sale_timesheet");
    const invoice = await rec.get("invoice_policy"), type = await rec.get("service_type");
    // `{v: k for k, v in map.items()}`: the last service policy wins for a duplicated pair
    let policy: string | null = null;
    for (const [service, inv, st] of SERVICE_TO_GENERAL) if (inv === invoice && st === type) policy = service;
    if (!policy && (await rec.get("type")) === "service") policy = "ordered_prepaid";
    return policy;
  },
  // account product.py:177-181 _compute_fiscal_country_codes: the fiscal country codes of the company or env.companies
  fiscal_country_codes: async (env, rec) => {
    const company = await rec.get("company_id");
    const companies = typeof company === "number" && company ? [company] : [...await env.companies()];
    const rows = (await env.cr.query<{ id: number; country: number | null; code: string | null }>(
      `SELECT c.id, c.account_fiscal_country_id AS country, co.code FROM res_company c
         LEFT JOIN res_country co ON co.id = c.account_fiscal_country_id WHERE c.id = ANY($1::int[])`, [companies])).rows;
    const byId = new Map(rows.map((r) => [r.id, r]));
    const seen = new Set<number>();
    const codes: string[] = [];
    for (const c of companies) {
      const r = byId.get(c);
      if (!r || r.country === null || seen.has(r.country)) continue;
      seen.add(r.country);
      if (r.code) codes.push(r.code);
    }
    return codes.join(",");
  },
});

/**
 * product_template.py:562-611 `_get_<weight|volume>_uom_name_from_ir_config_parameter`: the display name of the
 * unit chosen by product.weight_in_lbs / product.volume_in_cubic_feet ('1'), else kg / m³.
 */
async function configuredUomName(env: Environment, param: string, ifSet: string, otherwise: string): Promise<string> {
  const value = (await configParam(env, param)) || "0";
  const xmlid = value === "1" ? ifSet : otherwise;
  const id = await env.reg.xmlid(env.cr, xmlid);
  if (id === null) throw new NotPorted(`env.ref('${xmlid}')`);
  return String((await env.model("uom.uom").displayName([id])).get(id) ?? "");
}
defineComputes("product.template", {
  // product_template.py:613-619 _compute_weight_uom_name / _compute_volume_uom_name
  weight_uom_name: async (env) => configuredUomName(env, "product.weight_in_lbs", "uom.product_uom_lb", "uom.product_uom_kgm"),
  volume_uom_name: async (env) => configuredUomName(env, "product.volume_in_cubic_feet", "uom.product_uom_cubic_foot", "uom.product_uom_cubic_meter"),
});
registerRecordCompute("product.template", {
  // sale_project product_template.py:55-59 _compute_task_template (stored, company-dependent): dropped when its
  // project is not the product's
  task_template_id: async (env, rec) => {
    // the current value (reading the field itself here would recompute it)
    const current = await rec.prev("task_template_id");
    if (typeof current !== "number" || !current) return current;
    const ttProject = await new DbRec(env, env.reg.model("project.task"), current).get("project_id");
    if (ttProject && ttProject !== ((await rec.get("project_id")) || null)) return null;
    return current;
  },
});
defineComputes("product.template", {
  // product_template.py:1245-1255 _compute_valid_product_template_attribute_line_ids: the lines with values
  valid_product_template_attribute_line_ids: async (_env, rec) => {
    const out: number[] = [];
    for (const line of await rec.rels("attribute_line_ids")) {
      const values = await line.get("value_ids");
      if (Array.isArray(values) && values.length && line.id !== null) out.push(line.id);
    }
    return out;
  },
  // sale product_template.py:108-114 _compute_visible_reinvoice_policy (sale_timesheet's pre-assignment at
  // product_template.py:40-45 is overwritten by this super call); sale_expense product_template.py:32-35 adds
  // expensable products for expense users
  visible_reinvoice_policy: async (env, rec) => {
    const modules = env.reg.model("product.template").modules ?? [];
    if ((await hasGroup(env, "analytic.group_analytic_accounting")) || (await hasGroup(env, "sale.group_services_and_material"))) {
      if ((await rec.get("purchase_ok")) || (await rec.get("sale_ok"))) return true;
    }
    if (modules.includes("sale_expense") && (await hasGroup(env, "hr_expense.group_hr_expense_user")) && (await rec.get("can_be_expensed"))) return true;
    return false;
  },
});
defineComputes("product.template", {
  // product_template.py:556-560 _compute_show_sales_price_page
  show_sales_price_page: async (env, rec) => (await hasGroup(env, "product.group_product_pricelist")) && Boolean(await rec.get("sale_ok")),
});
defineComputes("product.template", {
  // stock product.py:1049-1052 _compute_store_by
  store_by: async (_env, rec) => ((await rec.get("is_storable")) ? ((await rec.get("tracking")) || "quantity") : "untracked"),
});
registerRecordCompute("product.template", {
  // purchase product.py:22-29 _compute_purchase_method (stored, precompute): 'purchase' for services, else the
  // default_get value (ir.default / context), 'receive' without one
  purchase_method: async (env, rec) => {
    if ((await rec.get("type")) === "service") return "purchase";
    // default_get(['purchase_method']) without a field default: the context key, else ir.default (refused)
    const fromContext = env.context["default_purchase_method"];
    if (fromContext !== undefined) return fromContext;
    const userDefault = (await env.cr.query(
      `SELECT 1 FROM ir_default d JOIN ir_model_fields f ON f.id = d.field_id
        WHERE f.model = 'product.template' AND f.name = 'purchase_method'`)).rows.length;
    if (userDefault) throw new NotPorted("product.template.purchase_method with an ir.default");
    return "receive";
  },
});
registerRecordCompute("product.template", {
  // sale product_template.py:205-207 _compute_service_type (stored, precompute): 'manual' for goods or when unset,
  // and for storable products with sale_stock (product_template.py:15-18); else unchanged
  service_type: async (env, rec) => {
    const current = await rec.prev("service_type");
    if ((await rec.get("type")) === "consu" || !current) return "manual";
    const modules = env.reg.model("product.template").modules ?? [];
    if (modules.includes("sale_stock") && (await rec.get("is_storable"))) return "manual";
    return current;
  },
});
registerRecordCompute("product.template", {
  // sale product_template.py:209-215 _compute_invoice_policy (stored, precompute): the company's default when
  // unset, 'order' for goods, else unchanged
  invoice_policy: async (env, rec) => {
    const current = await rec.prev("invoice_policy");
    if (!current) {
      const company = new DbRec(env, env.reg.model("res.company"), await env.company());
      return (await company.get("sale_invoice_policy")) || null;
    }
    if ((await rec.get("type")) === "consu") return "order";
    return current;
  },
});
registerRecordCompute("product.template", {
  // product_template.py:546-549 _compute_barcode (stored): the barcode of a single variant, else unchanged
  barcode: async (_env, rec) => {
    const variants = await rec.rels("product_variant_ids");
    if (variants.length === 1) return variants[0]!.get("barcode");
    return rec.prev("barcode");
  },
});
defineComputes("product.template", {
  // stock product.py:888-891 _compute_serial_prefix_format
  serial_prefix_format: async (_env, rec) => {
    const seq = await rec.rel("lot_sequence_id");
    return (seq ? await seq.get("prefix") : null) || "";
  },
  // stock product.py:913-923 _compute_next_serial
  next_serial: async (_env, rec) => {
    const seq = await rec.rel("lot_sequence_id");
    if (!seq) return "0000001";
    const next = Number(await seq.get("number_next_actual"));
    const padding = Number(await seq.get("padding"));
    return `${String(next).padStart(padding, "0")}${String(await seq.get("suffix") || "")}`;
  },
});
defineComputes("ir.sequence", {
  // ir_sequence.py:97-107 _get_number_next_actual: number_next for no_gap, else the PostgreSQL sequence
  // ir_sequence_<id:03d> predicted without consuming it (ir_sequence.py:65-81 _predict_nextval)
  number_next_actual: async (env, rec) => {
    if (rec.id === null) return 0;
    if (await rec.get("implementation") !== "standard") return await rec.get("number_next");
    const seqname = `ir_sequence_${String(rec.id).padStart(3, "0")}`;
    const row = (await env.cr.query<{ last_value: string; increment_by: string; is_called: boolean }>(
      `SELECT last_value, (SELECT increment_by FROM pg_sequences WHERE sequencename = $1) AS increment_by, is_called FROM "${seqname}"`,
      [seqname])).rows[0]!;
    return row.is_called ? Number(row.last_value) + Number(row.increment_by) : Number(row.last_value);
  },
});
registerDefaults("product.template", {
  // stock product.py:850-851 lot_sequence_id default: env.ref('stock.sequence_production_lots', raise_if_not_found=False)
  lot_sequence_id: async (env) => (await env.reg.xmlid(env.cr, "stock.sequence_production_lots")) ?? false,
});

registerRecordCompute("product.template", {
  // product_template.py:646-649 _compute_default_code (stored): the code of a single variant, else unchanged
  default_code: async (_env, rec) => {
    const variants = await rec.rels("product_variant_ids");
    if (variants.length === 1) return variants[0]!.get("default_code");
    return rec.prev("default_code");
  },
  // product_template.py:293-306 _compute_has_configurable_attributes (stored) with has_dynamic_attributes (:1234-1242,
  // the lines having values, :1245-1255) and product_template_attribute_line.py:260-266 _is_configurable
  has_configurable_attributes: async (_env, rec) => {
    const lines = await rec.rels("attribute_line_ids");
    for (const line of lines) {
      if ((await line.rels("value_ids")).length === 0) continue;
      const attr = await line.rel("attribute_id");
      if (attr && (await attr.get("create_variant")) === "dynamic") return true;
    }
    for (const line of lines) {
      const values = await line.rels("value_ids");
      if (values.length >= 2) return true;
      const attr = await line.rel("attribute_id");
      if (attr && (await attr.get("display_type")) === "multi") return true;
      if (values.length === 1 && await values[0]!.get("is_custom")) return true;
    }
    return false;
  },
});
defineComputes("product.template", {
  // stock product.py:931-933 _compute_has_available_route_ids: search_count of the selectable routes (as the user)
  has_available_route_ids: async (env) => (await env.model("stock.route").searchCount(cond("product_selectable", "=", true))) > 0,
});

registerRecordCompute("product.template", {
  // product_template.py:731-735 _compute_base_unit_count (stored): the single variant's, else 0
  base_unit_count: async (_env, rec) => {
    const variants = await rec.rels("product_variant_ids");
    return variants.length === 1 ? variants[0]!.get("base_unit_count") : 0;
  },
  // product_template.py:742-746 _compute_base_unit_id (stored): the single variant's, else empty
  base_unit_id: async (_env, rec) => {
    const variants = await rec.rels("product_variant_ids");
    return variants.length === 1 ? (await variants[0]!.get("base_unit_id")) || null : null;
  },
});
defineComputes("product.template", {
  // product_template.py:309-315 _compute_is_dynamically_created
  is_dynamically_created: async (_env, rec) => {
    for (const line of await rec.rels("attribute_line_ids")) {
      const attr = await line.rel("attribute_id");
      if (attr && (await attr.get("create_variant")) === "dynamic") return true;
    }
    return false;
  },
});

defineComputes("product.template", {
  // product_template.py:542-543 _compute_is_product_variant
  is_product_variant: async () => false,
});
// non-stored fields without compute (fields.py:1973-1987): product_category / product_product / stock product.py
for (const [model, field] of [["product.category", "filter_for_stock_putaway_rule"], ["product.product", "catalog_is_in_order"],
  ["product.product", "catalog_is_in_selected_section"], ["product.product", "previously_bought_by_customer"],
  ["product.product", "sold_by_vendor_id"], ["product.template", "location_id"], ["product.template", "warehouse_id"]] as const) {
  registerDefaultValued(model, field);
}

/**
 * product_product.py:287-288 `_set_image_1920` -> :208-228 `_set_template_field('image_1920', 'image_variant_1920')`:
 * clearing an image the variant does not have, giving one to a variant of an imageless template, or any value on the
 * only active variant of its template goes to the template (the variant's own image cleared first); else the variant
 * keeps it as its own `image_variant_1920` (a write of the variant image, refused by the generic write). Values are
 * all read before any write, as Odoo reads them before the template write invalidates the variants.
 */
registerOverrides("product.product", {
  inverse: {
    image_1920: async (env, ids, vals) => {
      const value = vals["image_1920"];
      const plan: { id: number; tmpl: number; onTemplate: boolean }[] = [];
      for (const id of ids) {
        const tmpl = (await env.cr.query<{ t: number }>("SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [id])).rows[0]?.t;
        if (!tmpl) throw new NotPorted(`product.product ${id} without its template`);
        const onTemplate = (!value && !(await env.model("product.product").binaryValue(id, "image_variant_1920")))
          || (!!value && !(await env.model("product.template").binaryValue(tmpl, "image_1920")))
          || (await env.model("product.product").searchCount(and([cond("product_tmpl_id", "=", tmpl), cond("active", "=", true)]))) <= 1;
        plan.push({ id, tmpl, onTemplate });
      }
      for (const { id, tmpl, onTemplate } of plan) {
        if (onTemplate) {
          await write(env, "product.product", [id], { image_variant_1920: false });
          // the variant's web_save reads its image_N through the template's (imageReadFirst)
          await withImageWriteOrder(env, "product.template", imageReadFirst(env, "product.product"),
            () => write(env, "product.template", [tmpl], { image_1920: value || false }));
        } else {
          await write(env, "product.product", [id], { image_variant_1920: value });
        }
      }
    },
  },
});

/** product_product.py:281-310 _compute_image_<size>: the variant's image, else the template's. */
for (const size of ["1920", "1024", "512", "256", "128"]) {
  defineComputes("product.product", {
    [`image_${size}`]: async (env, rec) => {
      if (rec.origin === null) {
        // a new variant: its own (resized) image is only known when no image was given
        if (await rec.get("image_variant_1920")) throw new NotPorted(`product.product.image_${size} of a new variant with an image`);
        const tmpl = await rec.get("product_tmpl_id");
        if (typeof tmpl === "number" && tmpl) return env.model("product.template").binaryValue(tmpl, `image_${size}`);
        // a new variant's new template (orm/recompute.ts DELEGATE_PARENT_MODELS): its image, given or empty
        const parent = tmpl instanceof NewRec ? tmpl : rec instanceof NewRec && DELEGATE_PARENT_MODELS.has(rec.def.name) ? await rec.rel("product_tmpl_id") : null;
        if (parent instanceof NewRec && parent.origin === null) return (await parent.get(`image_${size}`)) || null;
        if (tmpl) throw new NotPorted(`product.product.image_${size} of a new variant of a new template`);
        return null;
      }
      // measured, not derived: image_1920 of a template-image variant reads with the content's sha256 (BinaryBytes,
      // binary.py:71; API corpus web_read), image_128 with the attachment's sha1 (web_search_read, gcrawl G159);
      // the other sizes keep the bytes until a reference shows them
      const asBytes = async (v: BinaryValue | null): Promise<BinaryValue | null> =>
        (v ? (size === "128" ? v : binaryBytes(await v.content(), v.filename, v.mimetype)) : null);
      const own = await env.model("product.product").binaryValue(rec.origin, `image_variant_${size}`);
      if (own) return asBytes(own);
      const tmpl = await rec.get("product_tmpl_id");
      return typeof tmpl === "number" && tmpl ? asBytes(await env.model("product.template").binaryValue(tmpl, `image_${size}`)) : null;
    },
  });
}

/** product_product.py:451-454 _compute_product_price_extra: the sum of the variant's attribute value extras. */
async function priceExtra(rec: Rec): Promise<number> {
  let total = 0;
  for (const ptav of await rec.rels("product_template_attribute_value_ids")) total += Number((await ptav.get("price_extra")) ?? 0);
  return total;
}
defineComputes("product.product", {
  price_extra: async (_env, rec) => priceExtra(rec),
  // product_product.py:456-459 _compute_product_lst_price: the template's list price plus the variant's extra
  lst_price: async (_env, rec) => Number((await rec.get("list_price")) ?? 0) + await priceExtra(rec),
});
/**
 * product_product.py:461-466 `_inverse_product_lst_price`: on the only variant (archived ones counted, active_test=False)
 * of a template without configurable attributes the price goes to the template's `list_price`; on any other variant
 * nothing is written (the value stays in Odoo's cache only, the variant keeps its computed price).
 */
registerOverrides("product.product", {
  inverse: {
    lst_price: async (env, ids, vals) => {
      const value = vals["lst_price"];
      for (const id of ids) {
        const tmpl = (await env.cr.query<{ t: number }>("SELECT product_tmpl_id AS t FROM product_product WHERE id = $1", [id])).rows[0]?.t;
        if (!tmpl) throw new NotPorted(`product.product ${id} without its template`);
        const variants = Number((await env.cr.query<{ n: string }>("SELECT count(*) AS n FROM product_product WHERE product_tmpl_id = $1", [tmpl])).rows[0]?.n ?? 0);
        if (variants !== 1) continue;
        const [t] = await env.model("product.template").read([tmpl], ["has_configurable_attributes"], "");
        if (t?.["has_configurable_attributes"]) continue;
        // both trackings are logged at precommit in the order they were prepared: the variant's write (open here)
        // before the template's, so the template's level closes after the variant's (orm/recompute.ts
        // deferredTrackingScope)
        const tracking = await import("../mail/tracking");
        const defer = tracking.trackDepth(env.cr, "product.product") > 0 && tracking.trackDepth(env.cr, "product.template") === 0;
        if (defer) await tracking.trackPrepare(env, "product.template", []);
        try {
          await write(env, "product.template", [tmpl], { list_price: value });
        } catch (e) {
          if (defer) tracking.trackAbortLevel(env.cr, "product.template");
          throw e;
        }
        if (defer) {
          const { closeTrackingScope } = await import("../mail/write_hooks");
          tracking.afterTracking(env.cr, "product.product", () => closeTrackingScope(env, "product.template"));
        }
      }
    },
  },
});
defineComputes("product.template", {
  // product_template.py:317-320 _compute_product_variant_id: the first of product_variant_ids
  product_variant_id: async (_env, rec) => (await rec.rels("product_variant_ids"))[0]?.id ?? null,
});
registerRecordCompute("product.template", {
  // stock_account product.py:30-34 _compute_lot_valuated (stored): reset unless tracked by lot or serial
  // (a tracked product's compute assigns nothing: a database record keeps its column, NULL for a new one)
  lot_valuated: async (_env, rec) => (["lot", "serial"].includes(String(await rec.get("tracking"))) ? (rec instanceof DbRec ? NOT_ASSIGNED : rec.prev("lot_valuated")) : false),
});

defineComputes("product.product", {
  // product_product.py:447-449 _compute_is_product_variant
  is_product_variant: async () => true,
});

registerHooks("product.template.attribute.line", {
  // product_template_attribute_line.py:13 `_rec_name = 'attribute_id'`: models.py:1504 _compute_display_name gives the
  // many2one's display name
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; attribute_id: number | null }>(
      "SELECT id, attribute_id FROM product_template_attribute_line WHERE id = ANY($1::int[])", [ids])).rows;
    const names = await env.model("product.attribute").displayName([...new Set(rows.map((r) => r.attribute_id).filter((a): a is number => a !== null))]);
    return new Map(rows.map((r) => [r.id, r.attribute_id === null ? "" : names.get(r.attribute_id) ?? ""]));
  },
});

registerRecordCompute("product.template", {
  // product_template.py:282-285 _compute_can_image_1024_be_zoomed (stored): `image_1920 and
  // is_image_size_above(image_1920, image_1024)` (src/orm/image_write.ts isImageSizeAbove)
  can_image_1024_be_zoomed: async (_env, rec) => {
    const i1920 = await rec.get("image_1920") as BinaryValue | null;
    if (!i1920) return false;
    const i1024 = await rec.get("image_1024") as BinaryValue | null;
    if (!i1024) return false;
    return isImageSizeAbove(await i1920.content(), await i1024.content());
  },
});

registerRecordCompute("product.template", {
  // stock product.py:1041-1044 _compute_tracking (stored): kept only for storable products
  tracking: async (_env, rec) => ((await rec.get("is_storable")) ? rec.prev("tracking") : null),
});

/** misc.py:1306-1376 formatLang(value, currency_obj=currency): HALF-EVEN to the currency decimals, lang grouping, symbol. */
export async function formatLangCurrency(env: Environment, value: number, currency: number | null): Promise<string> {
  const lang = await getLang(env);
  const l = (await env.cr.query<{ grouping: string; thousands_sep: string | null; decimal_point: string }>(
    "SELECT grouping, thousands_sep, decimal_point FROM res_lang WHERE code = $1", [lang.code])).rows[0];
  if (!l || l.grouping !== "[3,0]") throw new NotPorted(`formatLang grouping of ${lang.code}`);
  const c = currency === null ? null : (await env.cr.query<{ symbol: string | null; position: string | null; decimal_places: number }>(
    "SELECT symbol, position, decimal_places FROM res_currency WHERE id = $1", [currency])).rows[0] ?? null;
  const digits = c ? c.decimal_places : 2;
  // float_round HALF-EVEN on the scaled value
  const f = 10 ** digits, scaled = value * f, fl = Math.floor(scaled);
  const tie = Math.abs(scaled - fl - 0.5) <= 1e-9 * Math.max(1, Math.abs(scaled));
  const rounded = (tie ? (fl % 2 === 0 ? fl : fl + 1) : Math.round(scaled)) / f;
  const [int, dec] = Math.abs(rounded).toFixed(digits).split(".");
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, l.thousands_sep ?? "");
  const formatted = `${rounded < 0 ? "-" : ""}${grouped}${dec !== undefined ? l.decimal_point + dec : ""}`;
  if (c && c.symbol) return c.position === "after" ? `${formatted} ${c.symbol}` : `${c.symbol} ${formatted}`;
  return formatted;
}

registerHooks("product.supplierinfo", {
  // purchase_stock product.py:291-298 _compute_display_name: "<vendor> (<min_qty> <uom> - <price>)"; with
  // use_simplified_supplier_name the vendor (`_rec_name = 'partner_id'`, product_supplierinfo.py:12)
  displayName: async (env, ids) => {
    const rows = (await env.cr.query<{ id: number; partner_id: number; min_qty: number | null; price: number | null; currency_id: number | null; uom: string | null }>(
      `SELECT s.id, s.partner_id, s.min_qty::float8 AS min_qty, s.price::float8 AS price, s.currency_id,
              COALESCE(u.name->>$2, u.name->>'en_US') AS uom
         FROM product_supplierinfo s LEFT JOIN uom_uom u ON u.id = s.uom_id WHERE s.id = ANY($1::int[])`,
      [ids, env.lang ?? "en_US"])).rows;
    const partners = await env.model("res.partner").displayName([...new Set(rows.map((r) => r.partner_id))]);
    const out = new Map<number, string>();
    for (const r of rows) {
      const vendor = partners.get(r.partner_id) ?? "";
      if (env.context["use_simplified_supplier_name"]) { out.set(r.id, vendor); continue; }
      const price = await formatLangCurrency(env, r.price ?? 0, r.currency_id);
      out.set(r.id, `${vendor} (${pyFloatReprSimple(r.min_qty ?? 0)} ${r.uom ?? "False"} - ${price})`);
    }
    return out;
  },
});
registerRecordCompute("product.supplierinfo", {
  // the same compute (purchase_stock product.py:291-298) on a new record
  display_name: async (env, rec) => {
    const partner = await rec.rel("partner_id");
    const vendor = partner ? String((await partner.get("display_name")) || "False") : "False";
    if (env.context["use_simplified_supplier_name"]) return partner ? vendor : false;
    const uom = await rec.rel("uom_id");
    const uomName = uom ? String((await uom.get("name")) || "False") : "False";
    const qty = Number((await rec.get("min_qty")) ?? 0), price = Number((await rec.get("price")) ?? 0);
    const currency = await rec.get("currency_id");
    return `${vendor} (${pyFloatReprSimple(qty)} ${uomName} - ${await formatLangCurrency(env, price, typeof currency === "number" ? currency : null)})`;
  },
});

/** "<attribute>: <value>" display names of attribute values, in the env's language. */
async function attributeValueNames(env: Environment, ids: readonly number[], withAttribute: boolean, viaTemplate: boolean): Promise<Map<number, string>> {
  const lang = env.lang ?? "en_US";
  const rows = (await env.cr.query<{ id: number; attr: string | null; name: string | null }>(viaTemplate
    ? `SELECT v.id, COALESCE(a.name->>$2, a.name->>'en_US') AS attr, COALESCE(pav.name->>$2, pav.name->>'en_US') AS name
         FROM product_template_attribute_value v JOIN product_attribute_value pav ON pav.id = v.product_attribute_value_id
         JOIN product_attribute a ON a.id = pav.attribute_id WHERE v.id = ANY($1::int[])`
    : `SELECT pav.id, COALESCE(a.name->>$2, a.name->>'en_US') AS attr, COALESCE(pav.name->>$2, pav.name->>'en_US') AS name
         FROM product_attribute_value pav JOIN product_attribute a ON a.id = pav.attribute_id WHERE pav.id = ANY($1::int[])`,
  [[...ids], lang])).rows;
  return new Map(rows.map((r) => [r.id, withAttribute ? `${r.attr ?? "False"}: ${r.name ?? "False"}` : (r.name ?? "")]));
}
registerHooks("product.template.attribute.value", {
  // product_template_attribute_value.py:162-166 _compute_display_name (context display_attribute_name, default True)
  displayName: async (env, ids) => attributeValueNames(env, ids, Boolean(env.context["display_attribute_name"] ?? true), true),
});
registerHooks("product.attribute.value", {
  // product_attribute_value.py:60-73 _compute_display_name: with the attribute unless show_attribute is falsy
  // (then models.py's _rec_name 'name')
  displayName: async (env, ids) => attributeValueNames(env, ids, Boolean(env.context["show_attribute"] ?? true), false),
});

// product_product.py:1147-1198 name_search: the code, then the barcode, then code or name, then a `[code]` in the text,
// then (partner_id in context) the vendor's product code or name
registerHooks("product.product", {
  nameSearch: async (env, name, domain, operator, limit) => {
    const P = env.model("product.product");
    const lim = limit ?? undefined;
    const find = (d: Domain, l: number | undefined = lim) => P.search(and([domain, d]), l === undefined ? {} : { limit: l });
    let ids: number[] = [];
    if (!name) {
      ids = await find(cond("is_favorite", "=", true));
      const rest = limit === null ? undefined : limit - ids.length;
      if (rest === undefined || rest > 0) ids = [...ids, ...(await find(cond("is_favorite", "=", false), rest))];
    } else {
      const positive = ["=", "ilike", "=ilike", "like", "=like"].includes(operator);
      if (positive) {
        ids = await find(cond("default_code", operator, name));
        if (!ids.length) ids = await find(cond("barcode", "=", name));
      }
      if (!ids.length) {
        if (!isNegativeOperator(operator)) {
          ids = await find(cond("default_code", operator, name));
          const rest = limit === null ? undefined : limit - ids.length;
          if (rest === undefined || rest > 0) ids = [...ids, ...(await find(and([cond("id", "not in", ids), cond("name", operator, name)]), rest))];
        } else {
          ids = await find(and([cond("name", operator, name), or([cond("default_code", operator, name), cond("default_code", "=", false)])]));
        }
      }
      const m = /(\[(.*?)\])/.exec(name);
      if (!ids.length && positive && m) ids = await find(cond("default_code", "=", m[2]));
      // :1188-1197 still nothing, a partner in context: the vendor's product code or name (product.supplierinfo)
      const partner = env.context["partner_id"];
      if (!ids.length && partner) {
        const supplier = and([cond("partner_id", "=", partner as number), or([cond("product_code", operator, name), cond("product_name", operator, name)])]);
        ids = await find(cond("product_tmpl_id.seller_ids", "any", supplier));
      }
    }
    const names = await env.sudo().model("product.product").displayName(ids);
    return ids.map((id) => [id, names.get(id) ?? ""] as [number, string]);
  },
});

// product_product.py `_compute_can_image_variant_1024_be_zoomed` (stored): False without a variant image
registerRecordCompute("product.product", {
  can_image_variant_1024_be_zoomed: async (env, rec) => {
    if (rec.id === null) {
      if (await rec.get("image_variant_1920")) throw new NotPorted("can_image_variant_1024_be_zoomed of a new variant with an image");
      return false;
    }
    const has = (await env.cr.query("SELECT 1 FROM ir_attachment WHERE res_model = 'product.product' AND res_field = 'image_variant_1920' AND res_id = $1", [rec.id])).rows.length > 0;
    if (has) throw new NotPorted("can_image_variant_1024_be_zoomed of a variant with an image (is_image_size_above)");
    return false;
  },
});

// product_product.py:443-446 `_compute_combination_indices` (stored): the sorted ids of the variant's attribute values
registerRecordCompute("product.product", {
  combination_indices: async (_env, rec) => {
    const ids = ((await rec.get("product_template_attribute_value_ids")) as number[] | null ?? []).map(Number).sort((a, b) => a - b);
    return ids.join(",");
  },
});

// product_product.py:586-599 _onchange_default_code: a warning when another variant has the reference
registerOnchange("product.product", "_onchange_default_code", ["default_code"], async (env, rec) => {
  const code = await rec.get("default_code");
  if (!code) return;
  let domain: Domain = cond("default_code", "=", code as string);
  if (rec.origin !== null) domain = and([domain, cond("id", "!=", rec.origin)]);
  if (await env.model("product.product").searchCount(domain, 1)) {
    return { title: translate(env, "Note:"), message: translate(env, "The Reference '%s' already exists.").replace("%s", String(code)) };
  }
});

// product_attribute.py:101-104 _onchange_display_type: a multi-checkbox attribute without products creates no variants
registerOnchange("product.attribute", "_onchange_display_type", ["display_type"], async (env, rec) => {
  if ((await rec.get("display_type")) !== "multi") return;
  if (rec.origin !== null) throw new NotPorted("product.attribute._onchange_display_type of an edited attribute (number_related_products of a NewId)");
  if (Number((await rec.get("number_related_products")) ?? 0) === 0) await rec.set("create_variant", "no_variant");
});

// product_product.py:581-584 _onchange_standard_price
registerOnchange("product.product", "_onchange_standard_price", ["standard_price"], async (env, rec) => {
  const v = await rec.get("standard_price");
  const n = typeof v === "number" ? v : v !== null && typeof v === "object" && "float" in (v as object) ? Number((v as { float: number }).float) : Number(v ?? 0);
  if (n < 0) throw new ValidationError(translate(env, "The cost of a product can't be negative."));
});

/** A float field's value as a number (a PyFloat's float, a number as it is, an empty value 0). */
function floatValue(v: unknown): number {
  if (typeof v === "number") return v;
  if (v !== null && typeof v === "object" && "float" in (v as object)) return Number((v as { float: number }).float);
  return 0;
}

registerRecordCompute("uom.uom", {
  // uom_uom.py:52-59 `_compute_sequence` (precomputed): an existing unit's sequence is kept, otherwise
  // min(int(relative_factor * 100.0), 1000) (int truncates toward zero; l10n_mx's units, l10n_mx_uom.xml)
  sequence: async (_env, rec) => {
    if (rec.id !== null) {
      const current = await rec.prev("sequence");
      if (current) return current;
    }
    return Math.min(Math.trunc(floatValue(await rec.get("relative_factor")) * 100.0), 1000);
  },
  // uom_uom.py:61-67 `_compute_factor`: relative to its reference unit, else the relative factor itself
  factor: async (_env, rec) => {
    const rel = await rec.rel("relative_uom_id");
    const relative = floatValue(await rec.get("relative_factor"));
    return rel ? relative * floatValue(await rel.get("factor")) : relative;
  },
});
