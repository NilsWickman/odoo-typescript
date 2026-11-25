/**
 * The `value` of stock_account `_get_value_from_extra`'s dict (stock_move.py:524-528, :618-619) as a module's compiled
 * override returns it through callPrivate (src/models/stock_validate.ts inValue). An integral float from compiled code
 * is a PyFloat (`0 + 40.0` of stock_landed_costs' `accounting_data["value"] += lc.additional_landed_cost`), which the
 * `typeof === "number"` check refused before K2-base round 4; it is its number now. Anything else refuses.
 */
import { NotPorted } from "../errors";
import { plainNumber } from "../orm/values";

export function extraValue(extra: unknown): number {
  const v = extra !== null && typeof extra === "object" && !Array.isArray(extra) ? plainNumber((extra as { value?: unknown }).value) : undefined;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new NotPorted(`stock.move._get_value_from_extra returning ${JSON.stringify(extra)}`);
  return v;
}
