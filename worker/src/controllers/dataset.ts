/** web/controllers/dataset.py call_kw; method validation stays in http/methods.ts. */
import { HttpError, OdooError } from "../errors";
import { callKw } from "../http/methods";
import { jsonRoute } from "../http/router";

jsonRoute(["/web/dataset/call_kw", "/web/dataset/call_kw/<string:model>/<string:method>"], async ctx => {
  const p = ctx.jsonParams ?? {};
  if (typeof p["model"] !== "string" || typeof p["method"] !== "string") throw new OdooError("builtins.TypeError", "model and method are required");
  const args = p["args"] ?? [];
  const kwargs = p["kwargs"] ?? {};
  if (!Array.isArray(args) || typeof kwargs !== "object" || kwargs === null || Array.isArray(kwargs)) throw new OdooError("builtins.TypeError", "invalid args or kwargs");
  const env = await ctx.orm();
  // dataset.py:15-20 `_call_kw_readonly` (the route's readonly callback): `request.registry[model]` -> NotFound
  if (!env.reg.models.has(p["model"])) throw new HttpError(404, "");
  return callKw(env, p["model"], p["method"], args, kwargs as Record<string, unknown>);
});
