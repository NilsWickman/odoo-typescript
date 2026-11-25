"""lang_install.py -> gen/out/<template>/lang/<lang>.json: what `base.language.install.lang_install` loads for <lang>
(odoo/addons/base/wizard/base_language_install.py:35-63), read from the modules' .po files offline.

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/lang_install.py [lang ...]
(default sv_SE). The Worker (src/models/lang_install.ts) applies it at runtime with Odoo's own SQL.
GEN_CODE_ONLY=1 writes only `<lang>.code.json` (the server-side `_()` table, step 5 below) for a language that is
already active in the template (fr_FR in poc_erp, rådet runda 13): no install data, nothing written to the copy.

`lang_install` does, in order:
  1. `self.lang_ids.active = True` (an ORM write: res_lang.py:393-429)                    -> runtime, not here
  2. `mods._update_translations(codes, overwrite)` (ir_module.py:894-907): the installed modules in topological
     order of their dependencies, then `_load_module_terms` (ir_module.py:988-1006): for each module and lang the
     .po files (`get_po_paths`, translate.py:2421-2429) and the data files with translations
     (`get_datafile_translation_path`, translate.py:2432-2439) through one `TranslationImporter` (translate.py:2113),
     whose `_load` keeps two dictionaries and `save` writes them (translate.py:2196-2350):
       - `model_translations` {model: {field: {xmlid: {lang: value}}}} for fields with translate=True: one UPDATE per
         field over ir_model_data. Emitted here as `model`: the entries in the importer's insertion order (the SQL
         aggregates them WITH ORDINALITY, so order decides colliding xmlids). The runtime runs the same UPDATE, so
         records changed since the template are translated as Odoo would translate them.
       - `model_terms_translations` {model: {field: {xmlid: {src: {lang: value}}}}} for callable translate (views'
         arch_db, html fields): each record's terms are replaced inside its XML/HTML by
         `StoredTranslations.translated` (translate.py:480-...). That parser is not ported; instead the result is
         computed here for each record of the template, for both values of `do_overwrite`, keyed by a fingerprint of
         the values it depends on (en_US, _en_US, <lang>, _<lang>). Emitted as `terms`. A record whose current value
         has another fingerprint refuses at runtime (NotPorted) instead of guessing.
  3. `_load_non_installed_modules_manifest_terms(codes)` (ir_module.py:1009-1029): for every module not installed
     whose manifest carries translations, `module.write({field: {lang: value, 'en_US': source}})`. Emitted as
     `manifest` (module name -> vals); the runtime does the ORM write (write_uid, write_date).
  4. The returned action (base_language_install.py:43-63)                                  -> runtime

The importer's `save` is captured: the generator runs Odoo's own loading on the scratch copy, takes the two
dictionaries before they are written, computes the terms, then lets `save` run and rolls everything back.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

from odoo.tools import translate as tr  # noqa: E402
from odoo.tools import SQL  # noqa: E402

LANGS = tuple(sys.argv[1:]) or ('sv_SE',)


def fingerprint(values, lang):
    """sha256 of the keys `StoredTranslations.translated` reads for `lang` (src/models/lang_install.ts mirrors it):
    canonical JSON of {key: values[key]} for the keys present among en_US, _en_US, lang, _lang."""
    keep = {k: values[k] for k in ('en_US', '_en_US', lang, '_' + lang) if k in values}
    text = json.dumps(keep, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
    return hashlib.sha256(text.encode('utf-8')).hexdigest()


def capture_terms(env, importer, lang):
    """translate.py:2208-2268 for every record, without the UPDATE: {table, field, rows: {xmlid: {fp: [o0, o1]}}}."""
    out = []
    for model_name, model_dictionary in importer.model_terms_translations.items():
        Model = env[model_name]
        for field_name, field_dictionary in model_dictionary.items():
            field = Model._fields.get(field_name)
            rows_out = {}
            xmlids = list(field_dictionary.keys())
            for i in range(0, len(xmlids), 1000):
                params = [x.split('.', maxsplit=1) for x in xmlids[i:i + 1000]]
                rows = env.execute_query(SQL("""
                    SELECT m.id, imd.module || '.' || imd.name, m.%s, imd.noupdate
                    FROM %s m, "ir_model_data" imd
                    WHERE m.id = imd.res_id
                    AND (%s)
                """, SQL.identifier(field_name), SQL.identifier(Model._table), SQL(" OR ").join(
                    SQL("(imd.module = %s AND imd.name = %s)", *p) for p in params)))
                for id_, xmlid, values, imd_noupdate in rows:
                    if not values:
                        continue
                    if not values.get('_en_US', values['en_US']):
                        continue
                    record_dictionary = field_dictionary[xmlid]
                    term_updates = {}
                    for term_en, translations in record_dictionary.items():
                        for l, value in translations.items():
                            term_updates.setdefault(l, {})[term_en] = value
                    def changes(vals):
                        results = []
                        for do_overwrite in (False, True):
                            updated = dict(tr.StoredTranslations(vals).translated(env, field, env.lang or 'en_US', term_updates, overwrite=do_overwrite))
                            changed = {}
                            for l in term_updates:
                                new_val = updated.get(l)
                                if vals.get(l) != new_val:
                                    changed[l] = new_val
                                if f'_{l}' in vals:
                                    changed[f'_{l}'] = None
                            results.append(changed)
                        return results
                    # the same xmlid may match several rows of the table (another model's record with that xmlid):
                    # Odoo's query does not filter on imd.model, so neither does the runtime; key by id too
                    by_fp = rows_out.setdefault(xmlid, {}).setdefault(str(id_), {})
                    first = changes(values)
                    by_fp[fingerprint(values, lang)] = first
                    # the value after this load (jsonb_strip_nulls(value || changed), translate.py:2261): a second
                    # load ("Update Terms" on the language list) starts from it, with or without overwrite
                    for changed in first:
                        after = {k: v for k, v in {**values, **changed}.items() if v is not None}
                        by_fp.setdefault(fingerprint(after, lang), changes(after))
            out.append({'model': model_name, 'table': Model._table, 'field': field_name, 'rows': rows_out})
    return out


def main():
    with _odoo.env() as env:
        for lang in LANGS:
            if os.environ.get('GEN_CODE_ONLY') == '1':
                write_code(env, lang)
                continue
            lang_rec = env['res.lang'].with_context(active_test=False).search([('code', '=', lang)])
            assert lang_rec, f'{lang} is not a res.lang of {_odoo.DB}'
            lang_rec.active = True  # base_language_install.py:38 (the importer needs it active: translate.py:2161)
            saves = []  # every TranslationImporter.save with something to write, in call order
            orig_save = tr.TranslationImporter.save

            def save(self, overwrite=False, force_overwrite=False):
                if self.model_translations or self.model_terms_translations:
                    model = []
                    for model_name, model_dictionary in self.model_translations.items():
                        for field_name, field_dictionary in model_dictionary.items():
                            entries = []
                            for xmlid, translations in field_dictionary.items():
                                module, name = xmlid.split('.', maxsplit=1)
                                entries.append([module, name, dict(translations)])
                            model.append({'model': model_name, 'table': env[model_name]._table, 'field': field_name, 'entries': entries})
                    import traceback
                    caller = [f'{f.filename.split("/odoo/", 1)[-1]}:{f.lineno} {f.name}' for f in traceback.extract_stack()[-4:-1]]
                    saves.append({'overwrite': overwrite, 'force_overwrite': force_overwrite, 'caller': caller,
                                  'model': model, 'terms': capture_terms(env, self, lang)})
                return orig_save(self, overwrite=overwrite, force_overwrite=force_overwrite)

            tr.TranslationImporter.save = save
            try:
                mods = env['ir.module.module'].search([('state', '=', 'installed')])
                mods._update_translations([lang], True)  # base_language_install.py:39 (overwrite: the wizard's default)
            finally:
                tr.TranslationImporter.save = orig_save
            companies = env['res.company'].search([], order='id')
            guard = {'companies': [[c.id, c.chart_template or None] for c in companies]}
            # ir_module.py:1009-1029 without the write
            manifest = {}
            Module = env['ir.module.module']
            from odoo.modules import Manifest
            for module in Module.search([('state', '!=', 'installed')], order='id'):
                man = Manifest.for_addon(module.name, display_warning=False)
                if not man:
                    continue
                by_field = man.get_translations([lang])
                if not by_field:
                    continue
                source_terms = Module.get_values_from_terp(man)
                vals = {}
                for field_name, translations in by_field.items():
                    vals[field_name] = {**translations, 'en_US': source_terms[field_name]}
                manifest[module.name] = vals
            n_model = sum(len(m['entries']) for s in saves for m in s['model'])
            n_terms = sum(len(t['rows']) for s in saves for t in s['terms'])
            out = {
                '_meta': {'lang': lang, 'db': _odoo.DB, 'template': _odoo.TEMPLATE, 'model_entries': n_model, 'terms_xmlids': n_terms,
                          'saves': len(saves), 'manifest_modules': len(manifest),
                          'source': 'base_language_install.py:35-63, ir_module.py:894-1029, translate.py:2113-2350, account ir_module.py:106-115'},
                'guard': guard,
                'saves': saves,
                'manifest': manifest,
            }
            path = _odoo.write_json(os.path.join(_odoo.OUT, 'lang', f'{lang}.json'), out)
            print(path, out['_meta'])
            # the body of /web/webclient/translations?lang=<lang> once the language is active (gen/translations.py,
            # webclient.py:50-85), served from the same packaged directory (src/controllers/translations.ts)
            import translations
            body = translations.body_for(env, lang)
            path = _odoo.write_json(os.path.join(_odoo.OUT, 'lang', f'{lang}.webclient.json'), body)
            print(path, body['hash'], sum(len(m['messages']) for m in body['modules'].values()), 'messages')
            write_code(env, lang)


def write_code(env, lang):
    """`_()` on the server (translate.py:981-989 get_translation): per module, the `code` entries of its .po without
    the javascript comment (CodeTranslations._load_python_translations); a source missing from the caller's module
    stays in English, so the table is per module (src/models/util.ts translate)."""
    code = {}
    for m in sorted(env.registry._init_modules):
        tr_m = tr.code_translations.get_python_translations(m, lang)
        if tr_m:
            code[m] = dict(tr_m)
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'lang', f'{lang}.code.json'), code)
    print(path, len(code), 'modules', sum(len(v) for v in code.values()), 'sources')


if __name__ == '__main__':
    main()
