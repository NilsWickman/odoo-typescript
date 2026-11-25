/** account.tax `_search` helpers (account_tax.py:462-501), pure for the unit tests. */

/**
 * account_tax.py:462-484 `_parse_name_search`: "21M" -> "2%1%M", a quoted part kept as one `%`-wrapped piece
 * ("21\" M\"" -> "2%1% M%"); outside quotes the non-word characters (Python's Unicode `\W`) are dropped.
 */
export function parseTaxNameSearch(name: string): string {
  return name.split(/("[^"]*")/).map((part) => {
    if (!part) return part;
    if (/("[^"]*")/.test(part)) return `%${part.replace(/%/g, "_").replace(/"/g, "")}%`;
    return Array.from(part.replace(/[^\p{L}\p{N}_]+/gu, "")).join("%");
  }).join("");
}
