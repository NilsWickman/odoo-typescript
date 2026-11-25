/**
 * `properties.base.definition.get_properties_base_definition` (`odoo/addons/web/models/properties_base_definition.py:9`):
 * read access on the model, the field must be a `properties` field, then a sudo `web_search_read` of the definition
 * record with `{display_name, properties_definition}`. The display name ("%s Properties" of the model description,
 * `odoo/odoo/addons/base/models/properties_base_definition.py:27`) is the models stream's display-name hook.
 */
import { AccessError, NotPorted } from "../errors";
import { registerMethod } from "../http/methods";
import { envFor } from "./common";
import { and, cond } from "../orm/domain";
import { webSearchRead } from "./search_read";

export const PROPERTIES_BASE_DEFINITION = "properties.base.definition";

registerMethod(PROPERTIES_BASE_DEFINITION, "get_properties_base_definition", async (env0, _ids, args, kwargs0) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  const modelName = kwargs["model_name"] ?? args[0];
  const fieldName = kwargs["field_name"] ?? args[1];
  if (typeof modelName !== "string" || typeof fieldName !== "string") {
    throw new NotPorted(`get_properties_base_definition(${JSON.stringify(modelName)}, ${JSON.stringify(fieldName)})`);
  }
  const model = env.model(modelName);
  // `model.check_access("read")` on the empty recordset: the model-level permission (ir_access.py check_access)
  await model.checkAccess([], "read");
  const field = model.def.fields.get(fieldName);
  if (field === undefined) throw new NotPorted(`unknown field ${modelName}.${fieldName} (Python raises KeyError)`);
  if (field.type !== "properties") throw new AccessError("You can not read that field definition.");
  const domain = and([
    cond("properties_field_id.name", "=", fieldName),
    cond("properties_field_id.model", "=", modelName),
  ]);
  return webSearchRead(env.sudo(), PROPERTIES_BASE_DEFINITION, domain, {
    display_name: { empty: true },
    properties_definition: { empty: true },
  });
}, { apiModel: true, readonly: true });
