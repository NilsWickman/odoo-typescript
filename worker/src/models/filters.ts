/** ir.filters._list_all_models, base/models/ir_filters.py:57. */
import { registerHooks } from "../orm/hooks";

registerHooks('ir.filters', { selection: { model_id: async env => {
  const rows=await env.cr.query<{model:string;name:string}>(
    "SELECT model,COALESCE(name->>$1,name->>'en_US') AS name FROM ir_model ORDER BY 2",[env.lang??'en_US']);
  return rows.rows.map(r=>[r.model,r.name]);
} } });
