/** Pure helpers of the res.partner write path (no database): email normalisation and street splitting. */
import { NotPorted } from "../errors";

/** odoo/tools/mail.py:887 email_normalize for the plain-address case (email_split via getaddresses otherwise). */
export function emailNormalize(text: string | null): string | null {
  if (!text) return null;
  const s = text.trim();
  // tools/mail.py email_normalize -> email_split: a text without any '@' holds no address: False
  if (!s.includes("@")) return null;
  if (/[<>,;"()\s\\[\]:]/.test(s) || (s.match(/@/g) ?? []).length !== 1) throw new NotPorted(`email_normalize of ${JSON.stringify(text)}`);
  if (s.startsWith("@") || s.endsWith("@")) throw new NotPorted(`email_normalize of ${JSON.stringify(text)}`);
  const at = s.lastIndexOf("@");
  const local = s.slice(0, at), domain = s.slice(at + 1);
  // mail.py:960: an ascii local part is lowered, the domain always
  const ascii = /^[\x00-\x7f]*$/.test(local);
  return (ascii ? local.toLowerCase() : local) + "@" + domain.toLowerCase();
}

/** odoo/tools/business_data.py:6-30 _ADDRESS_REGEXES and :99 street_split (JS has no `(?(comma)...)`). */
export function streetSplit(street: string | null): { street_name: string; street_number: string; street_number2: string } {
  const s = street || "";
  const door = String.raw`(?:\s*[-,/]\s*(?<door>(?=.*\d)(?:(?!\s*,\s*|\s+-\s+).)+))?`;
  const re1 = new RegExp(String.raw`^(?<bn>[0-9][a-zA-Z0-9/-]*)[,\s]+(?<street>.*?)${door}$`, "s");
  // regex 2: `(?P<comma>,)?` then `(?(comma)|(?=\s+[,-/]|\s*$))` as two alternatives, the comma first
  const re2 = new RegExp(String.raw`^(?<street>.*?)\s*(?:(?<comma>,)\s*(?<bn1>[0-9][a-zA-Z0-9/-]*)?|\s*(?<bn2>[0-9][a-zA-Z0-9/-]*)?(?=\s+[,-/]|\s*$))${door}`, "s");
  const m1 = re1.exec(s);
  if (m1?.groups) {
    return { street_name: (m1.groups["street"] ?? "").trim(), street_number: (m1.groups["bn"] ?? "").trim(), street_number2: (m1.groups["door"] ?? "").trim() };
  }
  const m2 = re2.exec(s);
  if (m2?.groups) {
    const bn = m2.groups["bn1"] ?? m2.groups["bn2"] ?? "";
    return { street_name: (m2.groups["street"] ?? "").trim(), street_number: bn.trim(), street_number2: (m2.groups["door"] ?? "").trim() };
  }
  return { street_name: "", street_number: "", street_number2: "" };
}

/** res_partner.py:929 `_clean_website`: add the http scheme when missing (werkzeug url_parse/replace). */
export function cleanWebsite(website: string): string {
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(website);
  if (m) return website;
  // no scheme: `//host/path` keeps netloc; otherwise the whole path becomes the netloc
  if (website.startsWith("//")) return `http:${website}`;
  if (/[?#]/.test(website)) throw new NotPorted(`_clean_website of ${JSON.stringify(website)}`);
  return `http://${website}`;
}
