/**
 * Related (and `_inherits`-delegated) Selection fields take the target field's selection (fields.py:690
 * `setup_related`, `_setup_attrs__` copies `selection`), so gen/ marks them dynamic. The table
 * src/models/related_selections.json (src/models/gen_related_selections.py) resolves each to its static target;
 * this registers `selection` hooks for them, unless a model module already registered one for the field.
 * Models of the account/stock/purchase/payment streams are left to those streams.
 */
import { NotPorted } from "../errors";
import { hooksOf, registerHooks, type SelectionFn } from "../orm/hooks";
import type { Environment } from "../orm/types";
import TABLE from "./related_selections.json";
import { relatedSelection } from "./tail_util";

const OTHER_STREAMS = /^(account|stock|purchase|payment)\./;

function isRow(x: unknown): x is [string, string, string, string] {
  return Array.isArray(x) && x.length === 4 && x.every((v) => typeof v === "string");
}

for (const entry of TABLE as unknown[]) {
  if (!isRow(entry)) continue;
  const [model, field, targetModel, targetField] = entry;
  if (OTHER_STREAMS.test(model)) continue;
  if (hooksOf(model).selection?.[field] !== undefined) continue;
  registerHooks(model, { selection: { [field]: relatedSelection(targetModel, targetField) } });
}

/**
 * `_inherits` delegated fields (fields.py `inherited=True`, related to the parent record) share the parent field's
 * selection and description domain (`_description_domain` of the related field is the target's). The parent's
 * model modules register those hooks; the child reuses them for fields that are actually delegated.
 */
const DELEGATIONS: readonly [string, string][] = [["res.users", "res.partner"], ["product.product", "product.template"]];
for (const [child, parent] of DELEGATIONS) {
  const parentHooks = hooksOf(parent);
  const own = hooksOf(child);
  const selection: Record<string, SelectionFn> = {};
  for (const [field, fn] of Object.entries(parentHooks.selection ?? {})) {
    if (own.selection?.[field] !== undefined) continue;
    selection[field] = async (env) => {
      if (env.reg.model(child).fields.get(field)?.inheritedFrom !== parent) throw new NotPorted(`selection ${child}.${field}`);
      return fn(env);
    };
  }
  const descriptionDomain: Record<string, (env: Environment) => Promise<unknown>> = {};
  for (const [field, fn] of Object.entries(parentHooks.descriptionDomain ?? {})) {
    if (own.descriptionDomain?.[field] !== undefined) continue;
    descriptionDomain[field] = async (env) => {
      if (env.reg.model(child).fields.get(field)?.inheritedFrom !== parent) throw new NotPorted(`domain ${child}.${field}`);
      return fn(env);
    };
  }
  // registerHooks replaces descriptionDomain as a whole (hooks.ts): keep the child's own
  registerHooks(child, { selection, descriptionDomain: { ...own.descriptionDomain, ...descriptionDomain } });
}
