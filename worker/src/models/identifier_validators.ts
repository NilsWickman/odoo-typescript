/**
 * The `validation_function` of identifiers (odoo/tools/partner_identifiers.py), ported one by one: python-stdnum's
 * `validate`, which returns the compact number or raises. `null` means invalid; an identifier missing here is not
 * ported (callers refuse).
 */
import { VAT_MODULES } from "./vat_stdnum";

/** stdnum/util.py `clean(number, deletechars)`: drop those characters. */
const clean = (number: string, chars: string): string => [...number].filter((c) => !chars.includes(c)).join("");

/** stdnum/luhn.py `checksum` over decimal digits: 0 for a valid number. */
function luhnChecksum(number: string): number {
  const digits = [...number].reverse().map(Number);
  let sum = 0;
  digits.forEach((d, i) => { sum += i % 2 === 0 ? d : Math.floor((d * 2) / 10) + ((d * 2) % 10); });
  return sum % 10;
}

/** stdnum/se/orgnr.py `validate`: compact (' -.' removed, stripped), ten ASCII digits, Luhn. */
function seOrgnr(number: string): string | null {
  const n = clean(number, " -.").trim();
  if (!/^[0-9]+$/.test(n) || n.length !== 10) return null;
  return luhnChecksum(n) === 0 ? n : null;
}

/** A VAT module's `validate`: its compact number when valid (src/models/vat_stdnum.ts). */
const byVatModule = (cc: string) => (value: string): string | null => {
  const m = VAT_MODULES[cc]!;
  const c = m.compact(value);
  return m.isValid(c) ? c : null;
};

export const IDENTIFIER_VALIDATORS: Readonly<Record<string, (value: string) => string | null>> = {
  SE_EN: seOrgnr, // partner_identifiers.py:865-875 se_en.validate
  BE_EN: byVatModule("BE"), // :513 be_vat.validate
  DK_CVR: byVatModule("DK"), // :570 dk_cvr.validate
};
