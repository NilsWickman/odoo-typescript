/** Generic web methods use the model supplied by the call_kw dispatcher. */
import { type MethodOptions, registerMethod } from "../http/methods";
import type { Environment } from "../orm/types";

export type WebMethodFn = (
  env: Environment,
  ids: number[] | null,
  args: unknown[],
  kwargs: Record<string, unknown>,
  model: string,
) => Promise<unknown>;

/** The models whose call_kw the recorded scenarios and the fuzz scope reach (harness SCOPE_MODELS plus comodels). */
export const BASE_MODELS: readonly string[] = [
  "res.partner", "res.partner.category", "res.partner.industry", "res.partner.bank", "res.partner.title",
  "res.users", "res.company", "res.country", "res.country.state", "res.city", "res.lang", "res.currency", "res.groups",
  "mail.activity", "mail.activity.type", "mail.message", "mail.followers", "mail.message.subtype",
  "ir.filters", "ir.ui.view", "ir.model", "ir.model.fields", "ir.attachment", "ir.actions.actions",
  "ir.actions.act_window", "ir.actions.server", "properties.base.definition",
];

export function registerBaseMethod(method: string, fn: WebMethodFn, opts: MethodOptions): void {
  registerMethod("*", method, fn, opts);
}
