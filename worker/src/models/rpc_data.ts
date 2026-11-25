/**
 * `export_data` and `load` through call_kw (XML-RPC, JSON-RPC, /json/2 and the web client), for the models where
 * Odoo's methods and the helpers they call are BaseModel's own (gen/orm_methods.py `export_data`, `load`): models.py
 * :924-937 `export_data` -> `_export_rows` (src/controllers/export.ts) and :943-1119 `load` (src/orm/load.ts, the
 * same code as the import wizard). `load` is registered only where `create` and `write` are Odoo's own or ported
 * (src/orm/write.ts overrides), plus res.partner, whose `_load_records_create` (res_partner.py:1072-1108) is ported in
 * src/models/res_partner_write.ts (`registerLoadRecordsCreate`: the commercial and address sync of rows with parents).
 */
import { NotPorted, OdooError } from "../errors";
import { lookupMethod, registerMethod } from "../http/methods";
import { exportData } from "../controllers/export";
import { load } from "../orm/load";
import { overridesOf } from "../orm/write";
import { envFor } from "../web/common";
import genErp from "../../gen/out/poc_erp/orm_methods.json" with { type: "json" };

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new OdooError("builtins.TypeError", `${what} must be a list`);
  return v;
}

const models = genErp.models as Record<string, string[]>;
const LOAD_OVERRIDES = new Set(["res.partner"]);

for (const [model, methods] of Object.entries(models)) {
  if (methods.includes("export_data") && lookupMethod(model, "export_data") === null) {
    registerMethod(model, "export_data", async (env0, ids, args, kwargs0) => {
      const { env, kwargs } = envFor(env0, kwargs0);
      const fields = list("fields_to_export" in kwargs ? kwargs["fields_to_export"] : args[0], "fields_to_export").map(String);
      return { datas: await exportData(env, model, ids ?? [], fields) };
    }, { apiModel: false });
  }
  const loadable = methods.includes("load") || LOAD_OVERRIDES.has(model);
  const creates = methods.includes("create") || overridesOf(model).create !== undefined;
  const writes = methods.includes("write") || overridesOf(model).write !== undefined;
  if (loadable && creates && writes && lookupMethod(model, "load") === null) {
    registerMethod(model, "load", async (env0, _ids, args, kwargs0) => {
      const { env, kwargs } = envFor(env0, kwargs0);
      const fields = list("fields" in kwargs ? kwargs["fields"] : args[0], "fields").map(String);
      const data = list("data" in kwargs ? kwargs["data"] : args[1], "data").map((r) => list(r, "data row"));
      return load(env, model, fields, data);
    }, { apiModel: true });
  }
}
