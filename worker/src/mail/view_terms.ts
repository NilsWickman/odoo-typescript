/**
 * The terms of a QWeb view in another language, for the templates the port writes out by hand (mail.account_security_alert,
 * mail.mail_notification_light): `arch_db` is `translate=xml_translate` (odoo/odoo/addons/base/models/ir_ui_view.py), so
 * the stored arch in the language is the en_US arch with each term's text replaced and the markup and whitespace around it
 * kept (odoo/tools/translate.py `xml_translate`). The two archs are split into tags and texts; when their tags are the
 * same, each text of the en_US arch (stripped) gives the text at the same place in the other language. A view whose tags
 * differ between the languages (a translation that moves inline markup), a term met twice with different translations
 * or a term the arch does not have refuse.
 */
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";

const TOKEN = /<[^>]*>|[^<]+/g;

/** The texts of `en` mapped to those of `other`, or null when the tags of the two archs differ. */
export function termMap(en: string, other: string): Map<string, string | null> | null {
  const a = en.match(TOKEN) ?? [], b = other.match(TOKEN) ?? [];
  if (a.length !== b.length) return null;
  const out = new Map<string, string | null>();
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    const tag = x.startsWith("<");
    if (tag !== y.startsWith("<")) return null;
    if (tag) {
      if (x !== y) return null;
      continue;
    }
    const k = x.trim(), v = y.trim();
    if (!k) continue;
    const prev = out.get(k);
    out.set(k, prev === undefined || prev === v ? v : null);
  }
  return out;
}

/** A translator of the terms of the views `xmlids` (merged) into `env.lang`: the identity for en_US. */
export async function viewTerms(env: Environment, xmlids: readonly string[]): Promise<(term: string) => string> {
  const lang = env.lang ?? "en_US";
  if (lang === "en_US") return (t) => t;
  const map = new Map<string, string | null>();
  for (const xmlid of xmlids) {
    const [module, name] = xmlid.split(".");
    const r = (await env.cr.query<{ en: string | null; other: string | null }>(
      `SELECT v.arch_db->>'en_US' AS en, v.arch_db->>$3 AS other FROM ir_ui_view v
         JOIN ir_model_data d ON d.model = 'ir.ui.view' AND d.res_id = v.id WHERE d.module = $1 AND d.name = $2`, [module, name, lang])).rows[0];
    if (!r?.en) throw new NotPorted(`view ${xmlid} for its terms`);
    // a view without the language reads as en_US (fields_textual.py:421 COALESCE)
    const m = termMap(r.en, r.other ?? r.en);
    if (m === null) throw new NotPorted(`terms of ${xmlid} in ${lang}: the translated arch moves markup`);
    for (const [k, v] of m) {
      const prev = map.get(k);
      map.set(k, prev === undefined || prev === v ? v : null);
    }
  }
  return (term) => {
    const v = map.get(term);
    if (v === undefined) throw new NotPorted(`term "${term}" not in ${xmlids.join(", ")}`);
    if (v === null) throw new NotPorted(`term "${term}" of ${xmlids.join(", ")} translated two ways in ${lang}`);
    return v;
  };
}
