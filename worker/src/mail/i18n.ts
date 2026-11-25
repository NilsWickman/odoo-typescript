/**
 * The `_()` strings the mail write side emits ("%s created", mail_thread.py:522; "Yes"/"No" of a tracked boolean,
 * mail_track_mixin.py:547-548), translated like any `_()` of the mail module (src/models/util.ts `translateLang`,
 * the generated .po tables of src/orm/code_translations.ts: sv_SE on poc_erp). Where no table is generated (fr_FR,
 * poc_corpus) the three strings keep their copies from odoo/addons/mail/i18n/fr.po (PORTING_odoo.md 12.6, O4); any
 * other language or string refuses.
 */
import { NotPorted } from '../errors';
import { codeTranslation } from '../orm/code_translations';

const TABLE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  // mail/i18n/fr.po:541, :9377, :15935
  fr_FR: { '%s created': '%s créé', 'No': 'Non', 'Yes': 'Oui' },
};

export function mailTranslate(lang: string | null | undefined, source: string): string {
  if (!lang || lang === 'en_US') return source;
  const t = codeTranslation(lang, 'mail', source) ?? TABLE[lang]?.[source];
  if (t === undefined) throw new NotPorted(`mail translation of "${source}" to ${lang}`);
  return t;
}
