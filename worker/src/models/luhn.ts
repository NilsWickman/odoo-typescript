/** python-stdnum luhn.py (the OCR numbers of l10n_se, account_move.py:9-29): `checksum` and `calc_check_digit`, base 10. */
export function luhnChecksum(number: string): number {
  // :50-58 digits from the right; every second one doubled and its two digits summed
  const digits = number.split("").reverse().map((c) => {
    if (!/^\d$/.test(c)) throw new Error(`luhn: ${number} is not a number`);
    return Number(c);
  });
  let sum = 0;
  digits.forEach((d, i) => { sum += i % 2 === 1 ? Math.floor((d * 2) / 10) + ((d * 2) % 10) : d; });
  return sum % 10;
}

/** :82-86 the digit that makes `number + digit` valid: `alphabet[-checksum(number + '0')]`. */
export function luhnCheckDigit(number: string): string {
  return String((10 - luhnChecksum(number + "0")) % 10);
}
