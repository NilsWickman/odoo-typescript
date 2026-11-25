/**
 * Wave 2 Settings domain: remaining `res.config` / `res.config.settings` buttons and the computes, defaults,
 * onchanges, and callable domains required by Settings group toggles (`group_analytic_accounting`,
 * `group_product_pricelist`, `group_show_uom_price`, `group_stock_multi_locations`, `group_stock_sign_delivery`,
 * `group_uom`) so turning them on serves every affected screen identically to Odoo 20 Community.
 */
import { NotPorted, OdooError, UserError } from "../errors";
import { callKw, registerMethod } from "../http/methods";
import { and, cond, or } from "../orm/domain";
import { hooksOf, registerHooks } from "../orm/hooks";
import { registerDefaults, registerOnchange, registerRecordCompute, type Rec } from "../orm/recompute";
import type { Domain, Environment } from "../orm/types";
import { write } from "../orm/write";
import { envFor } from "../web/common";
import { tryLoadingHooked } from "./chart_load";
import { convertAmount } from "./currency_convert";
import { countryPricelists } from "./partner_erp";
import { saveSfuClientAsset, SFU_CLIENT_SOURCE_URL } from "./res_config_settings_save";
import { availableUoms } from "./sale_computes";
import { configParam, defineComputes, searchCount } from "./tail_util";
import { datetimeToString, dbNow, todayInTz, translate } from "./util";

type ButtonFn = (env: Environment, ids: number[], args: unknown[], kwargs: Record<string, unknown>) => Promise<unknown>;

function button(model: string, method: string, fn: ButtonFn, opts?: { readonly apiModel?: boolean; readonly readonly?: boolean }): void {
  registerMethod(model, method, async (env0, ids, args, kwargs0) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return fn(env, ids ?? [], args, kwargs);
  }, { apiModel: opts?.apiModel ?? false, ...(opts?.readonly ? { readonly: true } : {}) });
}

function ensureOne(ids: readonly number[], model: string): number {
  if (ids.length !== 1) {
    throw new OdooError("builtins.ValueError", `Expected singleton: ${model}(${ids.join(", ")}${ids.length === 1 ? "," : ""})`);
  }
  return ids[0]!;
}

function idOf(v: unknown): number | null {
  if (typeof v === "number" && v > 0) return v;
  if (Array.isArray(v) && typeof v[0] === "number" && v[0] > 0) return v[0];
  return null;
}

const RELOAD_ACTION = { type: "ir.actions.client", tag: "reload" } as const;

// ----------------------------------------------------------------------------------------------------------
// 1. res.config & res.config.settings buttons and computes
// ----------------------------------------------------------------------------------------------------------

// base/models/res_config.py:22-96
button("res.config", "start", async () => ({ ...RELOAD_ACTION }));
button("res.config", "next", async () => ({ ...RELOAD_ACTION }));
button("res.config", "cancel", async () => null);
button("res.config", "action_next", async () => {
  throw new OdooError("builtins.NotImplementedError", "Configuration items need to implement execute");
});
button("res.config", "action_skip", async () => ({ ...RELOAD_ACTION }));
button("res.config", "action_cancel", async () => ({ ...RELOAD_ACTION }));

// base/models/res_config.py:405-410 res.config.settings.cancel
button("res.config.settings", "cancel", async (env) => {
  const actions = await env.model("ir.actions.act_window").search(cond("res_model", "=", "res.config.settings"), { limit: 1 });
  if (actions.length) {
    const [act] = await env.model("ir.actions.act_window").read(actions, [], "");
    if (act) return act;
  }
  return {};
});

// base/models/ir_ui_menu.py:44-55 _compute_complete_name / _get_full_name
async function menuFullName(env: Environment, rec: Rec, level = 6): Promise<string | false> {
  if (level <= 0) return "...";
  const name = await rec.get("name");
  const nameStr = typeof name === "string" ? name : "";
  const parent = await rec.rel("parent_id");
  if (parent) {
    const pName = await menuFullName(env, parent, level - 1);
    return `${pName || ""}/${nameStr}`;
  }
  return typeof name === "string" ? name : false;
}

defineComputes("ir.ui.menu", {
  complete_name: (env, rec) => menuFullName(env, rec, 6),
});

// base/models/res_config.py:419-431 get_option_path
button("res.config.settings", "get_option_path", async (env, _ids, args) => {
  const xmlid = String(args[0] ?? "");
  const menuId = await env.reg.xmlid(env.cr, xmlid);
  if (menuId === null) throw new OdooError("builtins.ValueError", `External ID not found in the system: ${xmlid}`);
  const [menu] = await env.model("ir.ui.menu").read([menuId], ["complete_name", "action"], "");
  const actStr = typeof menu?.["action"] === "string" ? menu["action"] : "";
  const actId = actStr.includes(",") ? Number(actStr.split(",")[1]) : false;
  return [menu?.["complete_name"] ?? false, Number.isFinite(actId) && actId ? actId : false];
}, { apiModel: true, readonly: true });

// base/models/res_config.py:434-444 get_option_name
button("res.config.settings", "get_option_name", async (env, _ids, args) => {
  const full = String(args[0] ?? "");
  const dot = full.lastIndexOf(".");
  if (dot < 0) throw new OdooError("builtins.ValueError", `not enough values to unpack (expected 2, got 1)`);
  const modelName = full.slice(0, dot);
  const fieldName = full.slice(dot + 1);
  const fg = await callKw(env, modelName, "fields_get", [[fieldName]], {}) as Record<string, { string?: string }>;
  return fg[fieldName]?.string ?? "";
}, { apiModel: true, readonly: true });

// mail/models/res_config_settings.py:151-157 _compute_fail_counter
defineComputes("res.config.settings", {
  fail_counter: async (env) => {
    const prev = new Date((await dbNow(env)).getTime() - 30 * 86_400_000);
    return searchCount(env.sudo(), "mail.mail", and([cond("date", ">=", datetimeToString(prev)), cond("state", "=", "exception")]));
  },
});

// mail/models/res_config_settings.py:159-177 action_open_sfu_client_source & action_save_sfu_client_asset
button("res.config.settings", "action_open_sfu_client_source", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const att = (await env.cr.query<{ id: number }>(
    `SELECT id FROM ir_attachment WHERE type = 'binary' AND url = $1 ORDER BY id DESC LIMIT 1`,
    [SFU_CLIENT_SOURCE_URL],
  )).rows[0];
  if (att) throw new NotPorted("res.config.settings.action_open_sfu_client_source with existing attachment");
  await write(env, "res.config.settings", [id], { sfu_client_source: "" });
  const viewId = await env.reg.xmlid(env.cr, "mail.res_config_settings_view_form_sfu_client_source");
  if (viewId === null) throw new OdooError("builtins.ValueError", "External ID not found in the system: mail.res_config_settings_view_form_sfu_client_source");
  return {
    name: translate(env, "SFU Client Bundle", "mail"),
    type: "ir.actions.act_window",
    res_model: "res.config.settings",
    res_id: id,
    views: [[viewId, "form"]],
    target: "new",
    context: { dialog_size: "extra-large" },
  };
});

button("res.config.settings", "action_save_sfu_client_asset", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const [rec] = await env.model("res.config.settings").read([id], [
    "use_call_server", "use_sfu_server", "use_custom_sfu_client", "sfu_client_source",
  ], "");
  await saveSfuClientAsset(env, rec ?? {}, typeof rec?.["sfu_client_source"] === "string" ? rec["sfu_client_source"] : "");
  return { type: "ir.actions.act_window_close" };
});

// sale/wizard/res_config_settings.py:133-135 + payment/models/res_company.py:64-101
button("res.config.settings", "action_sale_start_payment_onboarding", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const [s] = await env.model("res.config.settings").read([id], ["company_id"], "");
  const companyId = idOf(s?.["company_id"]);
  if (companyId === null) return false;
  const [c] = await env.model("res.company").read([companyId], ["onboarding_payment_module"], "");
  const mod = c?.["onboarding_payment_module"];
  if (!mod || typeof mod !== "string") return false;
  const modName = `payment_${mod}`;
  const state = (await env.cr.query<{ state: string }>("SELECT state FROM ir_module_module WHERE name = $1", [modName])).rows[0]?.state;
  if (state === "uninstalled") throw new NotPorted(`res.config.settings.action_sale_start_payment_onboarding: installing ${modName}`);
  throw new NotPorted(`res.config.settings.action_sale_start_payment_onboarding: payment.provider.action_start_onboarding (${mod})`);
});

// account/models/res_config_settings.py:262-263 reload_template
button("res.config.settings", "reload_template", async (env, ids) => {
  const id = ensureOne(ids, "res.config.settings");
  const [s] = await env.model("res.config.settings").read([id], ["company_id"], "");
  const companyId = idOf(s?.["company_id"]);
  if (companyId === null) return null;
  const [c] = await env.model("res.company").read([companyId], ["chart_template"], "");
  const code = typeof c?.["chart_template"] === "string" && c["chart_template"] ? c["chart_template"] : null;
  await tryLoadingHooked(env, code, companyId, false);
  return null;
});

// ----------------------------------------------------------------------------------------------------------
// 2. group_stock_sign_delivery: stock.picking.is_signed
// ----------------------------------------------------------------------------------------------------------

defineComputes("stock.picking", {
  // stock/models/stock_picking.py:260-262 _compute_is_signed
  is_signed: async (_env, rec) => Boolean(await rec.get("signature")),
});

// ----------------------------------------------------------------------------------------------------------
// 3. group_show_uom_price: product.template & product.product base_unit_price / base_unit_name
// ----------------------------------------------------------------------------------------------------------

async function computeBaseUnitName(rec: Rec): Promise<string | false> {
  const u = await rec.rel("base_unit_id");
  const baseName = u ? await u.get("name") : false;
  if (typeof baseName === "string" && baseName) return baseName;
  const uomName = await rec.get("uom_name");
  return typeof uomName === "string" && uomName ? uomName : false;
}

defineComputes("product.template", {
  // product/models/product_template.py:753-765
  base_unit_price: async (_env, rec) => {
    const count = Number((await rec.get("base_unit_count")) ?? 0);
    const price = Number((await rec.get("list_price")) ?? 0);
    return count ? price / count : 0;
  },
  base_unit_name: (_env, rec) => computeBaseUnitName(rec),
});

defineComputes("product.product", {
  // product/models/product_product.py:630-645
  base_unit_price: async (_env, rec) => {
    if (rec.id === null && rec.origin === null) return 0;
    const count = Number((await rec.get("base_unit_count")) ?? 0);
    const price = Number((await rec.get("lst_price")) ?? 0);
    return count ? price / count : 0;
  },
  base_unit_name: (_env, rec) => computeBaseUnitName(rec),
});

// ----------------------------------------------------------------------------------------------------------
// 4. group_stock_multi_locations: stock.location.is_empty & storage category / package type weight_uom_name
// ----------------------------------------------------------------------------------------------------------

async function weightUomName(env: Environment): Promise<string> {
  const param = await configParam(env, "product.weight_in_lbs");
  const xmlid = param === "1" ? "uom.product_uom_lb" : "uom.product_uom_kgm";
  const uomId = await env.reg.xmlid(env.cr, xmlid);
  if (uomId === null) return "";
  const lang = env.lang ?? "en_US";
  const row = (await env.cr.query<{ n: string | null }>(
    "SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM uom_uom WHERE id = $1", [uomId, lang],
  )).rows[0];
  return row?.n ?? "";
}

defineComputes("stock.location", {
  // stock/models/stock_location.py:136-143 _compute_is_empty
  is_empty: async (env, rec) => {
    const locId = rec.id ?? rec.origin;
    if (locId === null) return true;
    const usage = await rec.get("usage");
    if (usage !== "internal" && usage !== "transit") return true;
    const quantIds = await env.model("stock.quant").search(cond("location_id", "=", locId));
    if (!quantIds.length) return true;
    const r = (await env.cr.query<{ s: string | null }>(
      "SELECT COALESCE(SUM(quantity), 0)::text AS s FROM stock_quant WHERE id = ANY($1::int[])", [quantIds],
    )).rows[0];
    return Number(r?.s ?? 0) <= 0;
  },
});

defineComputes("stock.storage.category", {
  // stock/models/stock_storage_category.py:36-37 _compute_weight_uom_name
  weight_uom_name: (env) => weightUomName(env),
});

defineComputes("stock.package.type", {
  // stock/models/stock_package_type.py:85-87 _compute_weight_uom_name
  weight_uom_name: (env) => weightUomName(env),
});

// ----------------------------------------------------------------------------------------------------------
// 5. group_product_pricelist: sale.order.has_active_pricelist, product.pricelist currency_id default,
//    res.partner.is_pricelist_manually_set on new records
// ----------------------------------------------------------------------------------------------------------

defineComputes("sale.order", {
  // sale/models/sale_order.py:667-674 _compute_has_active_pricelist
  has_active_pricelist: async (env, rec) => {
    const companyId = idOf(await rec.get("company_id"));
    const companies: (number | false)[] = companyId !== null ? [false, companyId] : [false];
    const found = await env.model("product.pricelist").search(
      and([cond("company_id", "in", companies), cond("active", "=", true)]),
      { limit: 1 },
    );
    return found.length > 0;
  },
});

registerDefaults("product.pricelist", {
  // product/models/product_pricelist.py:17-18 _default_currency_id
  currency_id: async (env) => {
    const company = await env.company();
    return (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]?.c ?? false;
  },
});

registerRecordCompute("res.partner", {
  // product/models/res_partner.py:38-46 _compute_is_pricelist_manually_set (for new/onchange records)
  is_pricelist_manually_set: async (env, rec) => {
    const cur = idOf(await rec.get("property_product_pricelist")) ?? false;
    const cid = idOf(await rec.get("country_id"));
    const defaults = await countryPricelists(env, cid !== null ? [cid] : []);
    const def = defaults.get(cid) ?? false;
    return cur !== def;
  },
});

// ----------------------------------------------------------------------------------------------------------
// 6. group_uom: allowed_uom_ids on sale/purchase/stock lines + uom.uom.product_uom_ids callable domain
// ----------------------------------------------------------------------------------------------------------

async function availableUomsWithSellers(env: Environment, product: Rec | null, filterVariant: boolean): Promise<number[]> {
  if (!product) return [];
  const out = await availableUoms(env, product);
  const prodId = product.id ?? product.origin;
  const tmplId = idOf(await product.get("product_tmpl_id"));
  if (tmplId === null) return out;
  const rows = (await env.cr.query<{ product_id: number | null; uom_id: number | null }>(
    `SELECT product_id, uom_id FROM product_supplierinfo WHERE product_tmpl_id = $1 ORDER BY sequence, id`, [tmplId],
  )).rows;
  for (const r of rows) {
    if (filterVariant && r.product_id !== null && r.product_id !== prodId) continue;
    if (r.uom_id !== null && !out.includes(r.uom_id)) out.push(r.uom_id);
  }
  return out;
}

defineComputes("sale.order.line", {
  // sale/models/sale_order_line.py:702-704 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUoms(env, await rec.rel("product_id")),
  // sale/models/sale_order_line.py:1681-1684 _compute_product_uom_readonly
  product_uom_readonly: async (_env, rec) => rec.id !== null && ["sale", "cancel"].includes(String(await rec.get("state"))),
});

defineComputes("purchase.order.line", {
  // purchase/models/purchase_order_line.py:537-542 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUomsWithSellers(env, await rec.rel("product_id"), true),
});

defineComputes("stock.move", {
  // stock/models/stock_move.py:209-211 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUomsWithSellers(env, await rec.rel("product_id"), false),
});

defineComputes("stock.move.line", {
  // stock/models/stock_move_line.py:100-102 _compute_allowed_uom_ids
  allowed_uom_ids: async (env, rec) => availableUomsWithSellers(env, await rec.rel("product_id"), false),
});

registerHooks("uom.uom", {
  descriptionDomain: {
    ...hooksOf("uom.uom").descriptionDomain,
    // product/models/uom_uom.py:11-19 _domain_product_uoms (Domain.TRUE serializes as [(1, '=', 1)])
    product_uom_ids: async (env) => {
      const pid = env.context["product_id"];
      const pids = env.context["product_ids"];
      const parts: unknown[] = [];
      if (pid) parts.push(["product_id", "=", pid]);
      if (Array.isArray(pids) && pids.length) parts.push(["product_id", "in", pids]);
      if (parts.length === 2) return ["|", parts[0], parts[1]];
      if (parts.length === 1) return [parts[0]];
      return [[1, "=", 1]];
    },
  },
});

// ----------------------------------------------------------------------------------------------------------
// 7. group_analytic_accounting: analytic plan, account, distribution model & applicability computes/onchanges
// ----------------------------------------------------------------------------------------------------------

async function projectPlanId(env: Environment): Promise<number> {
  const raw = await configParam(env.sudo(), "analytic.project_plan");
  const n = raw !== null && /^\s*\d+\s*$/.test(raw) ? Number(raw.trim()) : 0;
  if (!n) throw new UserError(translate(env, "A 'Project' plan needs to exist and its id needs to be set as `analytic.project_plan` in the system variables", "analytic"));
  return n;
}

defineComputes("account.analytic.plan", {
  // analytic/models/analytic_plan.py:146-148 _compute_analytic_account_count
  account_count: async (env, rec) => {
    const pid = rec.id ?? rec.origin;
    if (pid === null) return 0;
    return searchCount(env, "account.analytic.account", cond("plan_id", "=", pid));
  },
  // analytic/models/analytic_plan.py:151-175 _compute_all_analytic_account_count
  all_account_count: async (env, rec) => {
    const pid = rec.id ?? rec.origin;
    if (pid === null) return 0;
    const rows = (await env.cr.query<{ id: number }>(
      `SELECT child.id FROM account_analytic_plan parent
         JOIN account_analytic_plan child ON child.parent_path LIKE parent.parent_path || '%'
        WHERE parent.id = $1`,
      [pid],
    )).rows;
    const planIds = rows.length ? rows.map((r) => r.id) : [pid];
    return searchCount(env, "account.analytic.account", cond("plan_id", "in", planIds));
  },
  // analytic/models/analytic_plan.py:178-180 _compute_children_count
  children_count: async (env, rec) => {
    const pid = rec.id ?? rec.origin;
    if (pid === null) return 0;
    return searchCount(env, "account.analytic.plan", cond("parent_id", "=", pid));
  },
});

// analytic/models/analytic_plan.py:182-186 _onchange_parent_id
registerOnchange("account.analytic.plan", "_onchange_parent_id", ["parent_id"], async (env, rec) => {
  const baseId = await projectPlanId(env);
  if (rec.origin !== null && rec.origin === baseId) {
    const lang = env.lang ?? "en_US";
    const name = (await env.cr.query<{ n: string }>(
      "SELECT COALESCE(name->>$2, name->>'en_US') AS n FROM account_analytic_plan WHERE id = $1", [baseId, lang],
    )).rows[0]?.n ?? "";
    throw new UserError(translate(env, "You cannot add a parent to the base plan '%s'", "analytic").replace("%s", name));
  }
});

async function analyticDebitCreditBalance(env: Environment, rec: Rec): Promise<{ debit: number; credit: number; balance: number }> {
  const accId = rec.id ?? rec.origin;
  const planId = idOf(await rec.get("plan_id"));
  if (accId === null || planId === null) return { debit: 0, credit: 0, balance: 0 };
  // Determine root_id -> _strict_column_name()
  const pRow = (await env.cr.query<{ parent_path: string | null }>(
    "SELECT parent_path FROM account_analytic_plan WHERE id = $1", [planId],
  )).rows[0];
  const rootId = pRow?.parent_path ? Number(pRow.parent_path.split("/").filter(Boolean)[0]) : planId;
  const baseId = await projectPlanId(env);
  const col = rootId === baseId ? "account_id" : `x_plan${rootId}_id`;
  const lineDef = env.reg.model("account.analytic.line");
  if (!lineDef.fields.get(col)?.column) return { debit: 0, credit: 0, balance: 0 };

  const companies = await env.companies();
  const domainParts: Domain[] = [
    cond("company_id", "in", [false, ...companies]),
    cond(col, "=", accId),
  ];
  if (env.context["from_date"]) domainParts.push(cond("date", ">=", env.context["from_date"]));
  if (env.context["to_date"]) domainParts.push(cond("date", "<=", env.context["to_date"]));
  const lineIds = await env.model("account.analytic.line").search(and(domainParts));
  if (!lineIds.length) return { debit: 0, credit: 0, balance: 0 };

  const company = await env.company();
  const companyCurrency = (await env.cr.query<{ c: number }>("SELECT currency_id AS c FROM res_company WHERE id = $1", [company])).rows[0]!.c;
  const today = todayInTz(await dbNow(env), typeof env.context["tz"] === "string" ? env.context["tz"] : "UTC");

  const rows = (await env.cr.query<{ currency_id: number; credit: string; debit: string }>(
    `SELECT currency_id,
            COALESCE(SUM(CASE WHEN amount >= 0 THEN amount ELSE 0 END), 0)::text AS credit,
            COALESCE(SUM(CASE WHEN amount < 0 THEN amount ELSE 0 END), 0)::text AS debit
       FROM account_analytic_line WHERE id = ANY($1::int[]) GROUP BY currency_id`,
    [lineIds],
  )).rows;
  let credit = 0;
  let debitNeg = 0;
  for (const r of rows) {
    const cAmt = Number(r.credit);
    const dAmt = Number(r.debit);
    if (cAmt) credit += r.currency_id === companyCurrency ? cAmt : await convertAmount(env, cAmt, r.currency_id, companyCurrency, company, today, true);
    if (dAmt) debitNeg += r.currency_id === companyCurrency ? dAmt : await convertAmount(env, dAmt, r.currency_id, companyCurrency, company, today, true);
  }
  const debit = -debitNeg;
  return { debit, credit, balance: credit - debit };
}

async function analyticPlanColumn(env: Environment, planId: number): Promise<string> {
  const pRow = (await env.cr.query<{ parent_path: string | null }>(
    "SELECT parent_path FROM account_analytic_plan WHERE id = $1", [planId],
  )).rows[0];
  const rootId = pRow?.parent_path ? Number(pRow.parent_path.split("/").filter(Boolean)[0]) : planId;
  const baseId = await projectPlanId(env);
  return rootId === baseId ? "account_id" : `x_plan${rootId}_id`;
}

async function analyticMoveLineCount(env: Environment, accId: number, moveTypes: readonly string[]): Promise<number> {
  const candidateIds = (await env.cr.query<{ id: number }>(
    `SELECT l.id FROM account_move_line l
       JOIN account_move m ON m.id = l.move_id
      WHERE l.parent_state = 'posted'
        AND m.move_type = ANY($1::text[])
        AND l.analytic_distribution IS NOT NULL
        AND regexp_split_to_array(jsonb_path_query_array(l.analytic_distribution, '$.keyvalue()."key"')::text, '\\D+') @> ARRAY[$2::text]`,
    [moveTypes, String(accId)],
  )).rows.map((r) => r.id);
  if (!candidateIds.length) return 0;
  return searchCount(env, "account.move.line", cond("id", "in", candidateIds));
}

defineComputes("account.analytic.account", {
  // project/models/account_analytic_account.py:16-20 _compute_project_count
  project_count: async (env, rec) => {
    const accId = rec.id ?? rec.origin;
    if (accId === null) return 0;
    return searchCount(env, "project.project", cond("account_id", "=", accId));
  },
  // account/models/account_analytic_account.py:19-48 _compute_invoice_count & _compute_vendor_bill_count
  invoice_count: async (env, rec) => {
    const accId = rec.id ?? rec.origin;
    if (accId === null) return 0;
    return analyticMoveLineCount(env, accId, ["out_invoice", "out_refund", "out_receipt"]);
  },
  vendor_bill_count: async (env, rec) => {
    const accId = rec.id ?? rec.origin;
    if (accId === null) return 0;
    return analyticMoveLineCount(env, accId, ["in_invoice", "in_refund", "in_receipt"]);
  },
  // purchase/models/analytic_account.py:13-17 _compute_purchase_order_count
  purchase_order_count: async (env, rec) => {
    const accId = rec.id ?? rec.origin;
    const planId = idOf(await rec.get("plan_id"));
    if (accId === null || planId === null) return 0;
    const col = await analyticPlanColumn(env, planId);
    if (!env.reg.model("account.analytic.line").fields.get(col)?.column) return 0;
    return searchCount(env, "purchase.order", cond(`order_line.invoice_lines.analytic_line_ids.${col}`, "in", [accId]));
  },
  // analytic/models/analytic_account.py:156-196 _compute_debit_credit_balance
  debit: async (env, rec) => (await analyticDebitCreditBalance(env, rec)).debit,
  credit: async (env, rec) => (await analyticDebitCreditBalance(env, rec)).credit,
  balance: async (env, rec) => (await analyticDebitCreditBalance(env, rec)).balance,
});

async function accountPrefixPlaceholder(env: Environment, accountType: "expense" | "income", fallback: string): Promise<string> {
  const company = await env.company();
  const accIds = await env.model("account.account").search(
    and([cond("company_ids", "parent_of", [company]), cond("account_type", "=", accountType)]),
    { limit: 1 },
  );
  let prefixes = fallback;
  if (accIds.length) {
    const [acc] = await env.model("account.account").read(accIds, ["code"], "");
    const code = typeof acc?.["code"] === "string" ? acc["code"] : "";
    if (code) {
      const base = code.slice(0, 2);
      if (/^[+-]?\d+$/.test(base)) {
        const n = Number(base);
        prefixes = `${n}, ${n + 1}, ${n + 2}`;
      }
    }
  }
  return translate(env, "e.g. %(prefix)s", "account").replace("%(prefix)s", prefixes);
}

defineComputes("account.analytic.distribution.model", {
  // analytic/models/analytic_mixin.py:78-79 _compute_analytic_distribution (no-op)
  analytic_distribution: async (_env, rec) => rec.prev("analytic_distribution"),
  // account/models/account_analytic_distribution_model.py:54-70 _compute_prefix_placeholder
  prefix_placeholder: (env) => accountPrefixPlaceholder(env, "expense", "60, 61, 62"),
});

defineComputes("account.analytic.applicability", {
  // account/models/account_analytic_plan.py:34-56 _compute_prefix_placeholder
  account_prefix_placeholder: async (env, rec) => {
    const bd = await rec.get("business_domain");
    return bd === "bill"
      ? accountPrefixPlaceholder(env, "expense", "60, 61, 62")
      : accountPrefixPlaceholder(env, "income", "40, 41, 42");
  },
});
