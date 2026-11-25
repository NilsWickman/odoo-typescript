/**
 * phone_validation/models/models.py for one saved record of any model: `_phone_get_number_fields` (:16-21),
 * `_phone_get_country` (:23-45), `_phone_format` (:53-95), `_phone_get_formatted` (:118-131) and
 * `_phone_get_recipients_info` (:147-253), with mail's `_mail_get_partners` (mail/models/models.py:163-201, without
 * introspection). Used by the activity schedule wizard's phone (phone_validation/wizard/mail_activity_schedule.py).
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { canonicalPhone, internationalPhone } from "./phone";

/** `_phone_get_number_fields`: mobile and phone when the model has them; sale.order none (sale_order.py:2269-2272). */
export function phoneNumberFields(env: Environment, model: string): string[] {
  if (model === "hr.employee" || model === "hr.applicant") throw new NotPorted(`${model}._phone_get_number_fields`);
  if (model === "sale.order") return [];
  const def = env.reg.model(model);
  return ["mobile", "phone"].filter((f) => def.fields.has(f));
}

/** `_mail_get_partner_fields(introspect_fields=False)`: partner_id then partner_ids, whichever the model has. */
function partnerFields(env: Environment, model: string): string[] {
  const overridden = ["gamification.goal", "gamification.badge.user", "loyalty.card", "slide.channel", "slide.slide", "hr.employee"];
  if (overridden.includes(model)) throw new NotPorted(`${model}._mail_get_partner_fields`);
  const def = env.reg.model(model);
  return ["partner_id", "partner_ids"].filter((f) => def.fields.has(f));
}

const ids = (v: unknown): number[] => {
  if (Array.isArray(v)) {
    // many2one as [id, name], x2many as a list of ids
    if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "string") return [v[0]];
    return v.filter((x): x is number => typeof x === "number");
  }
  return typeof v === "number" && v > 0 ? [v] : [];
};

async function readOne(env: Environment, model: string, id: number, fields: string[]): Promise<Record<string, unknown>> {
  if (!fields.length) return {};
  return (await env.model(model).read([id], fields, ""))[0] ?? {};
}

/** `_mail_get_partners()[id]`: the partners of the partner fields, in field order, without duplicates. */
async function mailPartners(env: Environment, model: string, id: number): Promise<number[]> {
  const fields = partnerFields(env, model);
  const row = await readOne(env, model, id, fields);
  const out: number[] = [];
  for (const f of fields) for (const p of ids(row[f])) if (!out.includes(p)) out.push(p);
  return out;
}

/** `_phone_get_country()[id]`, else the company's country (`_phone_format` :87-90): a country code or null. */
async function phoneCountryCode(env: Environment, model: string, id: number): Promise<string | null> {
  const code = async (countryIds: number[]): Promise<string | null> => countryIds.length
    ? (await env.cr.query<{ code: string }>("SELECT code FROM res_country WHERE id = $1", [countryIds[0]])).rows[0]?.code ?? null : null;
  const def = env.reg.model(model);
  let found: string | null = null;
  if (def.fields.has("country_id")) found = await code(ids((await readOne(env, model, id, ["country_id"]))["country_id"]));
  if (found === null) {
    // every partner field with partners that have a country sets it: the last one wins (models.py:41-44)
    const fields = partnerFields(env, model);
    const row = await readOne(env, model, id, fields);
    for (const f of fields) {
      const partners = ids(row[f]);
      if (!partners.length) continue;
      // `partner_records.country_id`: the partners' countries in partner order, without duplicates
      const rows = (await env.cr.query<{ id: number; country_id: number | null }>(
        "SELECT id, country_id FROM res_partner WHERE id = ANY($1::int[])", [partners])).rows;
      const byId = new Map(rows.map((r) => [r.id, r.country_id]));
      const countries = partners.map((p) => byId.get(p)).filter((c): c is number => typeof c === "number");
      if (countries.length) found = await code(countries);
    }
  }
  if (found !== null) return found;
  const company = await env.company();
  return (await env.cr.query<{ code: string | null }>(
    "SELECT c.code FROM res_company co JOIN res_partner p ON p.id = co.partner_id LEFT JOIN res_country c ON c.id = p.country_id WHERE co.id = $1",
    [company])).rows[0]?.code ?? null;
}

/** `record._phone_format(fname=fname)` (E164) of a field's value: false when empty or invalid. */
async function formatField(env: Environment, model: string, id: number, value: unknown): Promise<string | false> {
  if (typeof value !== "string" || !value) return false;
  return canonicalPhone(value, await phoneCountryCode(env, model, id));
}

/** `_phone_get_recipients_info()[id]["number"]` (partner_fallback=True): the number as stored, not sanitized. */
export async function recipientNumber(env: Environment, model: string, id: number): Promise<string | false> {
  const fields = phoneNumberFields(env, model);
  const row = await readOne(env, model, id, fields);
  for (const f of fields) {
    if (await formatField(env, model, id, row[f])) return (row[f] as string) || false;
  }
  const partners = await mailPartners(env, model, id);
  if (partners.length) {
    const pfields = phoneNumberFields(env, "res.partner");
    let partner = partners[0]!, fname: string | null = null;
    outer: for (const p of partners) {
      partner = p;
      const prow = await readOne(env, "res.partner", p, pfields);
      for (const f of pfields) {
        if (await formatField(env, "res.partner", p, prow[f])) { fname = f; break outer; }
      }
    }
    const v = (await readOne(env, "res.partner", partner, [fname ?? "phone"]))[fname ?? "phone"];
    return typeof v === "string" && v ? v : false;
  }
  for (const f of fields) if (typeof row[f] === "string" && row[f]) return row[f] as string;
  return false;
}

/** `record._phone_get_formatted(number)`: INTERNATIONAL with the record's country, else the number itself. */
export async function phoneGetFormatted(env: Environment, model: string, id: number, number: string | false | null): Promise<string | false> {
  if (!number) return false;
  const e164 = await canonicalPhone(number, await phoneCountryCode(env, model, id));
  return (e164 ? await internationalPhone(e164) : false) || number;
}
