/**
 * `name_search` entry (`odoo/odoo/orm/models.py:1593`): the ORM's `nameSearch` does the display_name domain and the
 * per-model overrides (hooks.ts); this is only the call_kw glue. Returns `[[id, display_name], ...]`.
 */
import { registerBaseMethod } from "./register";
import { envFor, intArg, optStr } from "./common";
import { parseDomain, PyTypeError } from "../orm/domain";
import type { Environment } from "../orm/types";

/**
 * The class whose `name_search` a model resolves to (the last override in the installed modules), for Python's
 * TypeError text of a wrong call (`<qualname>.name_search() got an unexpected keyword argument 'args'`).
 */
const OVERRIDES: readonly [string, string, string][] = [
  ["account.account", "account", "AccountAccount"], ["account.tax", "account", "AccountTax"], ["hr.applicant", "hr_recruitment_skills", "HrApplicant"],
  ["hr.job", "hr_recruitment_skills", "HrJob"], ["product.product", "product", "ProductProduct"], ["res.partner", "purchase_stock", "ResPartner"],
  ["product.template", "product", "ProductTemplate"], ["project.tags", "project", "ProjectTags"], ["sale.order.line", "sale_service", "SaleOrderLine"],
  ["res.users", "base", "ResUsers"], ["website.route", "website", "WebsiteRoute"], ["res.country", "base", "ResCountry"], ["res.country.state", "base", "ResCountryState"],
];

async function qualname(env: Environment, model: string): Promise<string> {
  const hit = OVERRIDES.find(([m]) => m === model);
  if (!hit) return "BaseModel";
  const installed = (await env.cr.query("SELECT 1 FROM ir_module_module WHERE name = $1 AND state IN ('installed', 'to upgrade', 'to remove') LIMIT 1", [hit[1]])).rows.length;
  return installed ? hit[2] : "BaseModel";
}

const PARAMS = ["name", "domain", "operator", "limit"];

registerBaseMethod("name_search", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  // Python's binding of `name_search(self, name='', domain=None, operator='ilike', limit=100)`: the keywords in their
  // order (unknown, or already given by position), then the number of positional arguments
  for (const k of Object.keys(kwargs)) {
    const i = PARAMS.indexOf(k);
    if (i < 0) throw new PyTypeError(`${await qualname(env, model)}.name_search() got an unexpected keyword argument '${k}'`);
    if (i < args.length) throw new PyTypeError(`${await qualname(env, model)}.name_search() got multiple values for argument '${k}'`);
  }
  if (args.length > PARAMS.length) throw new PyTypeError(`${await qualname(env, model)}.name_search() takes from 1 to 5 positional arguments but ${args.length + 1} were given`);
  // positional order: name, domain, operator, limit (models.py:1593-1599 defaults '', None, 'ilike', 100)
  const name = optStr(kwargs["name"] ?? args[0], "name") ?? "";
  // models.py:1620 `Domain(domain or Domain.TRUE)`: a missing or None domain is everything
  const rawDomain = kwargs["domain"] ?? args[1];
  const domain = parseDomain(rawDomain === undefined || rawDomain === null || rawDomain === false ? [] : rawDomain);
  const operator = optStr(kwargs["operator"] ?? args[2], "operator") ?? "ilike";
  const limitRaw = kwargs["limit"] ?? args[3];
  const limit = limitRaw === undefined ? 100 : intArg(limitRaw, "limit", 100);
  const pairs = await env.model(model).nameSearch(name, domain, operator, limit);
  return pairs.map(([id, displayName]) => [id, displayName]);
}, { apiModel: true, readonly: true });
