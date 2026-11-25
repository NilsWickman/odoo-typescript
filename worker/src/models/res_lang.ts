/**
 * `res.lang` calls of the export dialog (`web/static/src/views/view_dialogs/export_data_dialog.js` loads the
 * languages with `search_read([], ['code', 'name'], order='name')`), plus the generic `search_read`
 * (`odoo/odoo/orm/models.py:5232-5268`) it and `ir.exports` use. The method is registered per model (not `'*'`):
 * only the models whose Python classes do not override `search_read` are listed (res.lang and ir.exports have no
 * override in base, web or mail).
 */
import { NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { parseDomain } from "../orm/domain";
import type { Environment, RecordValues } from "../orm/types";
import { envFor, intArg, optInt, optStr } from "../web/common";

/** models.py:5232 `search_read(domain=None, fields=None, offset=0, limit=None, order=None, **read_kwargs)`. */
export async function searchRead(env: Environment, model: string, args: unknown[], kwargs: Record<string, unknown>): Promise<RecordValues[]> {
  const pick = (name: string, pos: number): unknown => (name in kwargs ? kwargs[name] : args[pos]);
  const known = new Set(["domain", "fields", "offset", "limit", "order", "load"]);
  for (const k of Object.keys(kwargs)) if (!known.has(k)) throw new NotPorted(`search_read keyword ${k}`);
  if (args.length > 5) throw new NotPorted("search_read with positional read arguments");
  const rawDomain = pick("domain", 0);
  const domain = parseDomain(rawDomain === null || rawDomain === undefined || rawDomain === false ? [] : rawDomain);
  const rawFields = pick("fields", 1);
  let fields: string[];
  if (rawFields === null || rawFields === undefined || rawFields === false) fields = [];
  else if (Array.isArray(rawFields) && rawFields.every((f): f is string => typeof f === "string")) fields = rawFields;
  else throw new NotPorted(`search_read fields=${JSON.stringify(rawFields)}`);
  const offset = intArg(pick("offset", 2), "offset", 0);
  const limit = optInt(pick("limit", 3), "limit");
  const order = optStr(pick("order", 4), "order");
  const load = kwargs["load"];
  if (load !== undefined && load !== "_classic_read" && load !== "" && load !== null && load !== false) {
    throw new NotPorted(`search_read load=${JSON.stringify(load)}`);
  }
  const m = env.model(model);
  // models.py:5259: `if not fields: fields = list(self.fields_get(attributes=()))`
  if (fields.length === 0) fields = Object.keys(await m.fieldsGet(null, []));
  const ids = await m.search(domain, { offset, limit, order });
  // models.py:5265-5268: active_test is dropped from the context of the read
  let readEnv = env;
  if ("active_test" in env.context) {
    const { active_test: _drop, ...rest } = env.context;
    readEnv = env.withContext(rest);
  }
  // _read_format(fnames=fields): the ids come from the search, already checked; read() keeps their order
  const rows = await readEnv.model(model).read(ids, fields, load === undefined ? "_classic_read" : typeof load === "string" ? load : "");
  const byId = new Map(rows.map((r) => [Number(r["id"]), r]));
  return ids.map((id) => byId.get(id)).filter((r): r is RecordValues => r !== undefined);
}

export function registerSearchRead(model: string): void {
  registerMethod(model, "search_read", async (env0, _ids, args, kwargs0, name) => {
    const { env, kwargs } = envFor(env0, kwargs0);
    return searchRead(env, name, args, kwargs);
  }, { apiModel: true, readonly: true });
}

registerSearchRead("res.lang");
