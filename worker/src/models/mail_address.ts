/**
 * `res.partner.contact_address_inline` (odoo/odoo/addons/base/models/res_partner.py:586 `_compute_address`,
 * `_display_address(separator=', ')` :1310, `_prepare_display_address` :1291, `_get_address_format` :1288).
 * Non-stored; mail tracks it (addons/mail/models/res_partner.py:30, tracking=True). Formats that reference keys
 * other than the ones `_prepare_display_address` fills from plain values refuse.
 */
import { NotPorted } from '../errors';
import type { Environment } from '../orm/types';

const DEFAULT_FORMAT = '%(street)s\n%(street2)s\n%(city)s %(state_code)s %(zip)s\n%(country_name)s'; // :1286
const KEYS = new Set(['street', 'street2', 'zip', 'city', 'state_code', 'state_name', 'country_code', 'country_name', 'parent_name']);

interface Row {
  id: number; street: string | null; street2: string | null; zip: string | null; city: string | null;
  parent_id: number | null; commercial_company_name: string | null; state_code: string | null; state_name: string | null;
  country_code: string | null; country_name: string | null; address_format: string | null;
}

export function formatAddress(format: string, args: Readonly<Record<string, string>>, separator: string): string {
  // `address_format % args` (:1321) interprets the format's directives, never the values' ('Société 100% Bio')
  if (/%/.test(format.replace(/%\([a-z_0-9]+\)s/g, ''))) throw new NotPorted('address format with other % directives');
  const address = format.replace(/%\(([a-z_0-9]+)\)s/g, (_m, key: string) => {
    if (!KEYS.has(key)) throw new NotPorted(`address format key ${key}`);
    return args[key] ?? '';
  });
  // :1322-1323
  return address.replace(/ {2,}/g, ' ').split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/).map(l => l.trim()).filter(Boolean).join(separator);
}

export async function contactAddressInline(env: Environment, ids: readonly number[]): Promise<Map<number, string | false>> {
  return displayAddresses(env, ids, false, ', ');
}

/** `_display_address(without_name, separator)` (res_partner.py:1310-1323) of each partner ('' when empty -> false). */
export async function displayAddresses(env: Environment, ids: readonly number[], withoutName: boolean, separator: string): Promise<Map<number, string | false>> {
  const lang = env.lang ?? 'en_US';
  const rows = (await env.cr.query<Row>(
    `SELECT p.id, p.street, p.street2, p.zip, p.city, p.parent_id, p.commercial_company_name,
            s.code AS state_code, s.name AS state_name, c.code AS country_code,
            COALESCE(c.name->>$2, c.name->>'en_US') AS country_name, c.address_format
       FROM res_partner p LEFT JOIN res_country_state s ON s.id = p.state_id LEFT JOIN res_country c ON c.id = p.country_id
      WHERE p.id = ANY($1::int[])`, [ids, lang])).rows;
  const out = new Map<number, string | false>();
  for (const r of rows) {
    let format = r.address_format || DEFAULT_FORMAT;
    if (r.parent_id && !withoutName) format = '%(parent_name)s\n' + format; // :1303-1306
    const value = formatAddress(format, {
      street: r.street ?? '', street2: r.street2 ?? '', zip: r.zip ?? '', city: r.city ?? '',
      state_code: r.state_code ?? '', state_name: r.state_name ?? '', country_code: r.country_code ?? '',
      country_name: r.country_name ?? '', parent_name: withoutName ? '' : r.commercial_company_name ?? '',
    }, separator);
    out.set(r.id, value || false);
  }
  return out;
}
