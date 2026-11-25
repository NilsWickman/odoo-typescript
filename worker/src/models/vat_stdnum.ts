/**
 * python-stdnum 1.19's VAT modules of the countries the port checks with their own prefix (res_partner.py:1403-1474
 * `_run_vat_checks`, src/models/res_partner_write.ts): `get_cc_module(cc, 'vat')` is ie.vat, nl.btw, at.uid and
 * lt.pvm, no.mva (checked by Odoo's own check_vat_no), lu.tva, au.abn and gt.nit (Odoo's check_vat_gt). `compact` and `is_valid`, as stdnum writes
 * them; `clean` takes ASCII input only (its unicode dash and space folding, util.py `_clean_chars`, is not ported:
 * other input refuses). Compared with stdnum on the cases of src/models/vat_stdnum.test.ts.
 */
import { NotPorted } from "../errors";

/** util.py:161-182 `clean(number, deletechars)` for ASCII input. */
function clean(n: string, chars: string): string {
  if (/[^\x20-\x7e]/.test(n)) throw new NotPorted("stdnum clean of a non-ASCII number");
  return [...n].filter((c) => !chars.includes(c)).join("");
}

/** util.py:186-190 `isdigits`: `^[0-9]+$`. */
const isdigits = (n: string): boolean => /^[0-9]+$/.test(n);

/** Python's `s[a:b]` with negative indexes (the strings are ASCII). */
function slice(s: string, a?: number, b?: number): string {
  const len = s.length;
  const norm = (i: number | undefined, d: number): number => (i === undefined ? d : i < 0 ? Math.max(0, len + i) : Math.min(i, len));
  const start = norm(a, 0), end = norm(b, len);
  return end > start ? s.slice(start, end) : "";
}

/** `str.strip()` of ASCII whitespace. */
const strip = (s: string): string => s.replace(/^[ \t\n\r\x0b\x0c]+|[ \t\n\r\x0b\x0c]+$/g, "");

const withoutPrefix = (n: string, cc: string): string => (n.startsWith(cc) ? n.slice(cc.length) : n);

// -- ie/vat.py ----------------------------------------------------------------------------------------------------
const IE_ALPHABET = "WABCDEFGHIJKLMNOPQRSTUV";

function ieCompact(number: string): string {
  return withoutPrefix(strip(clean(number, " -").toUpperCase()), "IE");
}

function ieCheck(number: string): string {
  const n = ieCompact(number).padStart(7, "0");
  let sum = 0;
  for (const [i, c] of [...slice(n, 0, 7)].entries()) sum += (8 - i) * Number(c);
  const rest = slice(n, 7);
  const idx = IE_ALPHABET.indexOf(rest); // `_alphabet.index('')` is 0; a character not in it raises (invalid)
  if (idx < 0) return "";
  return IE_ALPHABET[(sum + 9 * idx) % 23]!;
}

function ieValid(number: string): boolean {
  const n = ieCompact(number);
  if (!isdigits(slice(n, 0, 1)) || !isdigits(slice(n, 2, 7))) return false;
  if (![...slice(n, 7)].every((x) => IE_ALPHABET.includes(x))) return false;
  if (n.length !== 8 && n.length !== 9) return false;
  if (isdigits(slice(n, 0, 7))) return n[7] === ieCheck(slice(n, 0, 7) + slice(n, 8));
  if ("ABCDEFGHIJKLMNOPQRSTUVWXYZ+*".includes(n[1]!)) return n[7] === ieCheck(slice(n, 2, 7) + n[0]);
  return false;
}

// -- nl/btw.py, nl/bsn.py, iso7064/mod_97_10.py -------------------------------------------------------------------
function bsnCompact(number: string): string {
  return strip(clean(number, " -.")).padStart(9, "0");
}

function bsnValid(number: string): boolean {
  const n = bsnCompact(number);
  if (!isdigits(n) || Number(n) <= 0 || n.length !== 9) return false;
  let sum = 0;
  for (let i = 0; i < 8; i++) sum += (9 - i) * Number(n[i]);
  return (((sum - Number(n[8])) % 11) + 11) % 11 === 0;
}

function mod9710Valid(number: string): boolean {
  let rest = 0;
  for (const c of number) {
    const v = parseInt(c, 36);
    if (Number.isNaN(v) || !/^[0-9A-Za-z]$/.test(c)) return false; // int(x, 36) raises: InvalidFormat
    for (const d of String(v)) rest = (rest * 10 + Number(d)) % 97;
  }
  return rest === 1;
}

function nlCompact(number: string): string {
  const n = withoutPrefix(strip(clean(number, " -.").toUpperCase()), "NL");
  return bsnCompact(slice(n, 0, -3)) + slice(n, -3);
}

function nlValid(number: string): boolean {
  const n = nlCompact(number);
  if (!isdigits(slice(n, 0, 9)) || Number(slice(n, 0, 9)) <= 0) return false;
  if (!isdigits(slice(n, 10)) || Number(slice(n, 10)) <= 0) return false;
  if (n.length !== 12 || n[9] !== "B") return false;
  return bsnValid(slice(n, 0, 9)) || mod9710Valid("NL" + n);
}

// -- at/uid.py, luhn.py -------------------------------------------------------------------------------------------
function luhnChecksum(digits: string): number {
  const r = [...digits].reverse().map(Number);
  let sum = 0;
  for (let i = 0; i < r.length; i++) {
    if (i % 2 === 0) sum += r[i]!;
    else { const d = r[i]! * 2; sum += Math.floor(d / 10) + (d % 10); }
  }
  return sum % 10;
}

function atCompact(number: string): string {
  return withoutPrefix(strip(clean(number, " -./").toUpperCase()), "AT");
}

function atValid(number: string): boolean {
  const n = atCompact(number);
  if (slice(n, 0, 1) !== "U" || !isdigits(slice(n, 1))) return false;
  if (n.length !== 9) return false;
  return String((((6 - luhnChecksum(slice(n, 1, 8))) % 10) + 10) % 10) === n[8];
}

// -- lt/pvm.py ----------------------------------------------------------------------------------------------------
function ltCompact(number: string): string {
  return withoutPrefix(strip(clean(number, " -").toUpperCase()), "LT");
}

function ltCheck(digits: string): string {
  const d = [...digits].map(Number);
  let check = d.reduce((s, n, i) => s + (1 + (i % 9)) * n, 0) % 11;
  if (check === 10) check = d.reduce((s, n, i) => s + (1 + ((i + 2) % 9)) * n, 0);
  return String((check % 11) % 10);
}

function ltValid(number: string): boolean {
  const n = ltCompact(number);
  if (!isdigits(n)) return false;
  if (n.length === 9) { if (n[7] !== "1") return false; } else if (n.length === 12) { if (n[10] !== "1") return false; } else return false;
  return ltCheck(slice(n, 0, -1)) === n[n.length - 1];
}

// -- no/mva.py (compact) with base res_partner.py:2102-2126 `check_vat_no` (Odoo's own check, preferred to stdnum's) ----
function noCompact(number: string): string {
  return withoutPrefix(strip(clean(number, " ").toUpperCase()), "NO");
}

function noValid(vat: string): boolean {
  let v = vat;
  if (v.length === 12 && v.toUpperCase().endsWith("MVA")) v = v.slice(0, -3);
  if (v.length !== 9) return false;
  if (!/^[0-9]{9}$/.test(v)) {
    // `int(vat)` also takes a sign or underscores (then `int(vat[0])` raises): not ported
    if (/^\s*[+-]?[0-9](_?[0-9])*\s*$/.test(v)) throw new NotPorted(`check_vat_no of ${JSON.stringify(vat)}`);
    return false;
  }
  const d = [...v].map(Number);
  const sum = 3 * d[0]! + 2 * d[1]! + 7 * d[2]! + 6 * d[3]! + 5 * d[4]! + 4 * d[5]! + 3 * d[6]! + 2 * d[7]!;
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) return false;
  return check === d[8];
}

// -- lu/tva.py ----------------------------------------------------------------------------------------------------
function luCompact(number: string): string {
  return withoutPrefix(strip(clean(number, " :.-").toUpperCase()), "LU");
}

function luValid(number: string): boolean {
  const n = luCompact(number);
  if (!isdigits(n) || n.length !== 8) return false;
  return String(Number(slice(n, 0, 6)) % 89).padStart(2, "0") === slice(n, -2);
}

// -- au/abn.py (stdnum.au's `vat`) -----------------------------------------------------------------------------------
function auCompact(number: string): string {
  return strip(clean(number, " "));
}

function auCheckDigits(n: string): string {
  const w = [3, 5, 7, 9, 11, 13, 15, 17, 19];
  let s = 0;
  for (let i = 0; i < Math.min(w.length, n.length); i++) s += -w[i]! * Number(n[i]);
  return String(11 + ((((s - 1) % 89) + 89) % 89));
}

function auValid(number: string): boolean {
  const n = auCompact(number);
  if (!isdigits(n) || n.length !== 11) return false;
  return auCheckDigits(slice(n, 2)) === slice(n, 0, 2);
}

/**
 * Colombia: base res_partner.py:2362-2368 `format_vat_co` (Odoo's own, before stdnum's compact, :1534-1542):
 * co/nit.py `format(number)` without its dots and dash, then a dash before the check digit. nit.format joins every
 * character of `compact(number)` (`clean(number, '.,- ').upper().strip()`), so it is that number; an empty one is an
 * IndexError in Python (refused).
 */
function coFormat(n: string): string {
  const c = clean(n, ".,- ").toUpperCase().replace(/^\s+|\s+$/g, "");
  if (!c) throw new NotPorted("format_vat_co of an empty number (IndexError in stdnum's co.nit.format)");
  return c.length > 2 ? `${c.slice(0, -1)}-${c.slice(-1)}` : c;
}

/** co/nit.py:68-83 `validate`: 8 to 16 digits after compact, the last one `calc_check_digit` of the others (:56-62). */
function coValid(n: string): boolean {
  const c = clean(n, ".,- ").toUpperCase().replace(/^\s+|\s+$/g, "");
  if (c.length < 8 || c.length > 16 || !isdigits(c)) return false;
  const weights = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const body = [...c.slice(0, -1)].reverse();
  let sum = 0;
  for (let i = 0; i < Math.min(weights.length, body.length); i++) sum += weights[i]! * Number(body[i]);
  return "01987654321"[sum % 11] === c.slice(-1);
}

// -- gt/nit.py with base res_partner.py:1980-1991 `check_vat_gt` (Odoo's own, preferred to stdnum's) -------------
function gtCompact(number: string): string {
  return strip(clean(number, " -").toUpperCase()).replace(/^0+/, "");
}

function gtCheckDigit(n: string): string {
  let s = 0;
  [...n].reverse().forEach((c, i) => { s += (i + 2) * Number(c); });
  const c = ((-s % 11) + 11) % 11;
  return c === 10 ? "K" : String(c);
}

function gtValid(vat: string): boolean {
  // Infile's testing VATs: two fixed ones and `re.match(r'98[0-9]{10}K')` (anchored at the start only)
  if (vat === "11201220K" || vat === "11201350K" || /^98[0-9]{10}K/.test(vat)) return true;
  const n = gtCompact(vat);
  if (n.length < 2 || n.length > 12) return false;
  if (!isdigits(slice(n, 0, -1))) return false;
  const last = n[n.length - 1]!;
  if (last !== "K" && !isdigits(last)) return false;
  return last === gtCheckDigit(slice(n, 0, -1));
}

/** `get_cc_module(cc, 'vat')` of the countries ported here: its `compact` and the check `_check_vat_number` uses. */
// -- sg/uen.py (stdnum.sg: `uen as vat`) ----------------------------------------------------------------------------
const SG_OTHER_TYPES = new Set(["CC", "CD", "CH", "CL", "CM", "CP", "CS", "CX", "DP", "FB", "FC", "FM", "FN", "GA", "GB", "GS", "HS", "LL", "LP", "MB",
  "MC", "MD", "MH", "MM", "MQ", "NB", "NR", "PA", "PB", "PF", "RF", "RP", "SM", "SS", "TC", "TU", "VH", "XL"]);

/** uen.py `compact`: `clean(number).upper().strip()` (no characters deleted). */
function sgCompact(number: string): string {
  return strip(clean(number, "").toUpperCase());
}

const sgWeighted = (n: string, weights: readonly number[], value: (c: string) => number): number =>
  weights.reduce((t, w, i) => t + (i < n.length ? value(n[i]!) * w : 0), 0);

/** uen.py `validate`/`is_valid`: business (9), local company (10, a digit first) or other entities; the year as now. */
function sgValid(number: string): boolean {
  const n = sgCompact(number);
  if (n.length !== 9 && n.length !== 10) return false;
  const year = String(new Date().getFullYear());
  const isAlpha = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);
  if (n.length === 9) {
    if (!isdigits(slice(n, 0, -1)) || !isAlpha(n[n.length - 1])) return false;
    return n[n.length - 1] === "XMKECAWLJDB"[sgWeighted(n, [10, 4, 9, 3, 8, 2, 7, 1], Number) % 11];
  }
  if (isdigits(n[0]!)) {
    if (!isdigits(slice(n, 0, -1)) || slice(n, 0, 4) > year) return false;
    return n[n.length - 1] === "ZKCMDNERGWH"[sgWeighted(n, [10, 8, 6, 4, 9, 7, 5, 3, 1], Number) % 11];
  }
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWX0123456789";
  if (!["R", "S", "T"].includes(n[0]!) || !isdigits(slice(n, 1, 3))) return false;
  if (n[0] === "T" && slice(n, 1, 3) > year.slice(2)) return false;
  if (!SG_OTHER_TYPES.has(slice(n, 3, 5)) || !isdigits(slice(n, 5, -1))) return false;
  // alphabet.index raises on a character outside it (a ValueError, not a ValidationError: refused)
  const idx = (c: string): number => { const i = alphabet.indexOf(c); if (i < 0) throw new NotPorted("stdnum.sg.uen of a character outside its alphabet"); return i; };
  return n[n.length - 1] === alphabet[(((sgWeighted(n, [4, 3, 5, 3, 10, 2, 2, 5, 7], idx) - 5) % 11) + 11) % 11];
}


// -- EU neighbours (K2-base round 8: new suppliers of a Swedish company) ------------------------------------------
/** `compact` of the modules below: clean, upper, strip, the country prefix dropped. */
const euCompact = (chars: string, prefix: string) => (n: string): string => {
  const c = clean(n, chars).toUpperCase().trim();
  return c.startsWith(prefix) ? c.slice(2) : c;
};
const weighted = (n: string, weights: readonly number[]): number => weights.reduce((sum, w, i) => sum + w * Number(n[i]), 0);
const mod = (a: number, m: number): number => ((a % m) + m) % m; // Python's % (floor modulo)

/** dk/cvr.py: 8 digits, not starting with 0, weights 2 7 6 5 4 3 2 1 mod 11 = 0. */
const dkValid = (n: string): boolean => isdigits(n) && n[0] !== "0" && n.length === 8 && mod(weighted(n, [2, 7, 6, 5, 4, 3, 2, 1]), 11) === 0;
/** fi/alv.py: 8 digits, weights 7 9 10 5 8 4 2 1 mod 11 = 0. */
const fiValid = (n: string): boolean => isdigits(n) && n.length === 8 && mod(weighted(n, [7, 9, 10, 5, 8, 4, 2, 1]), 11) === 0;
/** pl/nip.py: 10 digits, weights 6 5 7 2 3 4 5 6 7 -1 mod 11 = 0. */
const plValid = (n: string): boolean => isdigits(n) && n.length === 10 && mod(weighted(n, [6, 5, 7, 2, 3, 4, 5, 6, 7, -1]), 11) === 0;
/** ee/kmkr.py: 9 digits, weights 3 7 1 3 7 1 3 7 1 mod 10 = 0. */
const eeValid = (n: string): boolean => isdigits(n) && n.length === 9 && mod(weighted(n, [3, 7, 1, 3, 7, 1, 3, 7, 1]), 10) === 0;

/** be/vat.py `compact`: also "(0)" as a leading 0 and the old 9-digit format. */
function beCompact(n: string): string {
  let c = euCompact(" -./", "BE")(n);
  if (c.startsWith("(0)")) c = "0" + c.slice(3);
  if (c.length === 9) c = "0" + c;
  return c;
}
/** be/vat.py: 10 digits, positive, (first 8 + last 2) mod 97 = 0. */
const beValid = (n: string): boolean => isdigits(n) && Number(n) > 0 && n.length === 10 && mod(Number(n.slice(0, -2)) + Number(n.slice(-2)), 97) === 0;

/** iso7064/mod_11_10.py checksum, valid when 1. */
function mod1110(n: string): number {
  let check = 5;
  for (const c of n) check = (((check || 10) * 2) % 11 + Number(c)) % 10;
  return check;
}
/** de/vat.py: 9 digits, not starting with 0, ISO 7064 Mod 11, 10; base res_partner.py:1958-1961 `check_vat_de` also
 * accepts a tax number (de/stnr.py), which is not ported: an invalid VAT refuses. */
function deValid(n: string): boolean {
  if (isdigits(n) && n[0] !== "0" && n.length === 9 && mod1110(n) === 1) return true;
  throw new NotPorted("check_vat_de of a number that is not a valid USt-IdNr (the stnr check)");
}

/** fr/siren.py: 9 digits, Luhn. */
const sirenValid = (n: string): boolean => isdigits(n) && n.length === 9 && luhnChecksum(n) === 0;
const FR_ALPHABET = "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
/** fr/tva.py `validate`. */
function frValid(n: string): boolean {
  if (![...n.slice(0, 2)].every((x) => FR_ALPHABET.includes(x)) || !isdigits(n.slice(2)) || n.length !== 11) return false;
  if (n.slice(2, 5) !== "000" && !sirenValid(n.slice(2))) return false;
  if (isdigits(n)) return Number(n.slice(0, 2)) === Number(BigInt(n.slice(2) + "12") % 97n);
  const check = isdigits(n[0]!) ? FR_ALPHABET.indexOf(n[0]!) * 24 + FR_ALPHABET.indexOf(n[1]!) - 10 : FR_ALPHABET.indexOf(n[0]!) * 34 + FR_ALPHABET.indexOf(n[1]!) - 100;
  return mod(Number(n.slice(2)) + 1 + Math.floor(check / 11), 11) === mod(check, 11);
}

/** it/iva.py `validate`: 11 digits, a non-zero first part, the province, Luhn. */
function itValid(n: string): boolean {
  if (!isdigits(n) || Number(n.slice(0, 7)) === 0 || n.length !== 11) return false;
  const p = n.slice(7, 10);
  if (!(("001" <= p && p <= "100") || ["120", "121", "888", "999"].includes(p))) return false;
  return luhnChecksum(n) === 0;
}

export const VAT_MODULES: Readonly<Record<string, { readonly compact: (n: string) => string; readonly isValid: (n: string) => boolean }>> = {
  IE: { compact: ieCompact, isValid: ieValid },
  NL: { compact: nlCompact, isValid: nlValid },
  AT: { compact: atCompact, isValid: atValid },
  LT: { compact: ltCompact, isValid: ltValid },
  AU: { compact: auCompact, isValid: auValid },
  NO: { compact: noCompact, isValid: noValid },
  LU: { compact: luCompact, isValid: luValid },
  CO: { compact: coFormat, isValid: coValid },
  GT: { compact: gtCompact, isValid: gtValid },
  SG: { compact: sgCompact, isValid: sgValid },
  DK: { compact: euCompact(" -.,/:", "DK"), isValid: dkValid },
  FI: { compact: euCompact(" -", "FI"), isValid: fiValid },
  PL: { compact: euCompact(" -", "PL"), isValid: plValid },
  EE: { compact: euCompact(" ", "EE"), isValid: eeValid },
  BE: { compact: beCompact, isValid: beValid },
  DE: { compact: euCompact(" -./,", "DE"), isValid: deValid },
  FR: { compact: euCompact(" -.", "FR"), isValid: frValid },
  IT: { compact: euCompact(" -:", "IT"), isValid: itValid },
};

/** res_partner.py:58-130 `_ref_vat` of these countries (the expected format in the error message). */
export const REF_VAT: Readonly<Record<string, string>> = {
  IE: "IE1234567FA", NL: "NL123456782B90", AT: "ATU12345675", LT: "LT123456715", NO: "NO123456785", LU: "LU12345613", AU: "83 914 571 673",
  CO: "213123432-1", MX: "GODE561231GR8", TR: "11111111111 (NIN) or 2222222222 (VKN)",
  BE: "BE0477472701", DK: "DK12345674", EE: "EE123456780", FI: "FI12345671", FR: "FR23334175221", IT: "IT12345670017", PL: "PL1234567883",
};
