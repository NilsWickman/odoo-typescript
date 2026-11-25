/** BaseModel.fields_get, odoo/orm/models.py:2677. */
import { registerBaseMethod } from "./register";
import { OdooError } from "../errors";

function names(value: unknown): string[] | null {
  if (value == null || value === false) return null;
  if (!Array.isArray(value) || !value.every(v => typeof v === "string")) throw new OdooError("builtins.TypeError", "expected a list of strings");
  return value;
}

registerBaseMethod("fields_get", async (env, _ids, args, kw, model) =>
  env.model(model).fieldsGet(names(kw["allfields"] ?? args[0]), names(kw["attributes"] ?? args[1])), { apiModel: true, readonly: true });
