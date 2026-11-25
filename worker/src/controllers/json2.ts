/**
 * The JSON-2 external API (odoo/addons/rpc/controllers/json2.py): `POST /json/2/<model>/<method>` with an API key as
 * bearer token (auth='bearer', bearer_scope='rpc', ir_http.py:318-357), the JSON body's `ids`, `context` and the
 * method's keyword arguments; `/json/2` and other paths under it answer Odoo's 404. The method runs as
 * `func(Model.browse(ids).with_context(context), **kwargs)` (no call_kw: the context replaces the request's, no
 * host_id is carried over); a recordset result is its ids.
 */
import { AccessError, HttpError, NotPorted } from "../errors";
import { ABSENT_METHODS, BASE_PRIVATE, CLASS_METHODS, lookupMethod, MODEL_PRIVATE, UNSAFE_ATTRIBUTES } from "../http/methods";
import { json2Route } from "../http/router";
import { pyRepr } from "../orm/domain";
import { ensureRegistryLang } from "../orm/registry";
import type { Context } from "../orm/types";
import { FILESTORE_READER_KEY } from "../models/binary";
import { PDF_ENGINE_KEY, pdfEngineOf } from "../report/engine";
import { APPS_INSTALLABLE_KEY, appsInstallableOnly } from "../modules/apps_visible";
import { readFile } from "../filestore";

// json2.py:37-47 web_json_2_404 (registered after the rule it would otherwise shadow: werkzeug prefers the
// two-argument rule over `<path:subpath>`)
json2Route("/json/2/<__model__>/<__method__>", async (ctx, p) => {
  const model = p["__model__"]!, method = p["__method__"]!;
  const env0 = await ctx.orm();
  if (!env0.reg.models.has(model)) throw new HttpError(404, `the model ${pyRepr(model)} does not exist`);
  const params = ctx.jsonParams ?? {};
  const { ids: rawIds, context: rawContext, __model__: _m, __method__: _f, ...kwargs } = params;
  void _m; void _f;
  // models.py:199-214 get_public_method: a private name raises AccessError (not caught), a missing one
  // AttributeError -> NotFound(exc.args[0])
  if (method.startsWith("_") || UNSAFE_ATTRIBUTES.has(method)) throw new AccessError(`Private methods (such as '${model}.${method}') cannot be called remotely.`);
  if (CLASS_METHODS.has(method)) throw new AccessError(`The method '${model}.${method}' cannot be called remotely.`);
  if (BASE_PRIVATE.has(method) || MODEL_PRIVATE[method]?.includes(model)) {
    throw new AccessError(`Private methods (such as '${model}.${method}') cannot be called remotely.`);
  }
  const registered = lookupMethod(model, method);
  if (registered === null && ABSENT_METHODS.has(method)) throw new HttpError(404, `The method '${model}.${method}' does not exist`);
  if (registered === null) throw new NotPorted(`json2 ${model}.${method} is not registered (src/web, src/models)`);
  const ids = rawIds === undefined ? [] : rawIds;
  if (!Array.isArray(ids) || !ids.every((x): x is number => typeof x === "number" && Number.isInteger(x))) {
    throw new NotPorted("json2 ids that are not a list of integers (browse)");
  }
  if (registered.apiModel && ids.length) throw new HttpError(422, `cannot call ${model}.${method} with ids`);
  const context: Context = rawContext === undefined ? {} : (rawContext as Context);
  if (typeof context !== "object" || context === null || Array.isArray(context)) throw new NotPorted("json2 context that is not a dict");
  const lang = context["lang"];
  if (typeof lang === "string" && lang !== "" && lang !== "en_US") await ensureRegistryLang(env0.cr, env0.reg, lang);
  const env = env0.withContext({ ...context });
  env.cache.set(FILESTORE_READER_KEY, (name: string) => readFile(ctx.env, env.cr.db, name));
  env.cache.set(PDF_ENGINE_KEY, pdfEngineOf(ctx.env, env.cr.db) !== null);
  env.cache.set(APPS_INSTALLABLE_KEY, appsInstallableOnly(ctx.env.APPS_INSTALLABLE_DBS, env.cr.db));
  // `signature.bind(records, **kwargs)`: the registered methods take their keyword arguments by name
  const result = await registered.fn(env, registered.apiModel ? null : ids, [], kwargs, model);
  return result === undefined ? null : result;
}, { auth: "bearer", bearerScope: "rpc", methods: ["POST"], saveSession: false, readonly: true, csrf: false });

json2Route(["/json/2", "/json/2/<path:subpath>"], async () => {
  throw new HttpError(404, "Did you mean POST /json/2/<model>/<method>?");
}, { auth: "public", readonly: true, csrf: false });
