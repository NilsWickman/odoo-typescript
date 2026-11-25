/** web/controllers/domain.py: `/web/domain/validate`, asked by the domain editor (Custom Filter, the domain field). */
import { OdooError, ValidationError } from "../errors";
import { jsonRoute } from "../http/router";
import { loadCodeTranslations } from "../orm/code_translations";
import { validateDomain } from "../orm/sql";
import { translate } from "../models/util";

jsonRoute("/web/domain/validate", async (ctx) => {
  const p = ctx.jsonParams ?? {};
  const missing = ["model", "domain"].filter((k) => !(k in p));
  if (missing.length) {
    throw new OdooError("builtins.TypeError",
      `DomainController.validate() missing ${missing.length} required positional argument${missing.length > 1 ? "s" : ""}: ${missing.map((k) => `'${k}'`).join(" and ")}`);
  }
  const env = await ctx.orm();
  const model = p["model"];
  // `request.env.get(model)`: None for a name that is not a model of the registry
  const def = typeof model === "string" ? env.reg.models.get(model) : undefined;
  if (def === undefined) {
    if (env.lang && env.lang !== "en_US") await loadCodeTranslations(env.cr, env.lang);
    throw new ValidationError(translate(env, "Invalid model: %s", "web").replace("%s", String(model)));
  }
  // `Domain(domain).validate(Model.sudo())`; ValueError and TypeError answer False
  try {
    await validateDomain(env.sudo(), def, p["domain"]);
    return true;
  } catch (e) {
    if (e instanceof OdooError && (e.odooName === "builtins.ValueError" || e.odooName === "builtins.TypeError")) return false;
    throw e;
  }
});
