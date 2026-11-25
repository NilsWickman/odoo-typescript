/** res.partner.bank `_get_available_qr_methods` rows as the hand port takes them (src/models/account_computes.ts qrMethods). */
import { NotPorted } from "../errors";
import { Markup } from "../pyexpr/values";
import { plainNumber } from "../orm/values";

/**
 * The rows of `_get_available_qr_methods` (code, label, sequence) as the hook gives them: a label must be text. A lazy
 * label of a compiled override (`_lt`, compiler/runtime/install.ts privateKey's `{kind: "lazy"}`) and any other object
 * refuse: `String()` of one is "[object Object]" (K2-base round 4). A Markup label is its text; a PyFloat sequence its
 * number.
 */
export function qrMethodRows(out: unknown): [string, string, number][] {
  if (!Array.isArray(out)) throw new NotPorted(`_get_available_qr_methods returning ${JSON.stringify(out)}`);
  return out.map((r) => {
    const seq = Array.isArray(r) ? plainNumber(r[2]) : undefined;
    if (!Array.isArray(r) || r.length !== 3 || typeof r[0] !== "string" || typeof seq !== "number" || !(typeof r[1] === "string" || r[1] instanceof Markup)) {
      throw new NotPorted(`_get_available_qr_methods entry ${JSON.stringify(r)}`);
    }
    return [r[0], String(r[1]), seq];
  });
}
