"""translations.py -> gen/out/translations/<lang>.json (en_US, fr_FR) and gen/out/translations/index.json.

Run: .venv/bin/python worker/gen/translations.py

Each <lang>.json is exactly the body Odoo returns for GET /web/webclient/translations?lang=<lang>&hash= with
no `mods` parameter (odoo/addons/web/controllers/webclient.py:50-85 WebClient.translations):
  mods        = registry._init_modules | config['server_wide_modules']                        (webclient.py:60)
  hash        = ir.http._get_web_translations_hash(mods, lang)                                (ir_http.py:567):
                sha1 of json.dumps({'lang_parameters', 'modules', 'lang', 'multi_lang'}, sort_keys=True)
  lang_parameters, modules = ir.http._get_translations_for_webclient(mods, lang)            (ir_http.py:541):
                lang_parameters from res.lang._lang_get(lang) (name, code, direction, date_format, time_format,
                grouping, decimal_point, thousands_sep, week_start as int); modules[m] =
                odoo.tools.translate.code_translations.get_web_translations(m, lang) (translate.py:2638), i.e. the
                `code` rows of <module>/i18n/<lang>.po with the javascript comment, as {"messages": [{id, string}]}
  multi_lang  = len(res.lang.get_installed()) > 1                                            (webclient.py:79)
The short form `?hash=<current>` answers only {'lang', 'hash'} (webclient.py:66-69); index.json holds the hash
per lang for that. Response headers: Cache-Control: public, max-age=31536000 (STATIC_CACHE_LONG).

Verification (README): the en_US file equals the S1 reference body (exchanges.jsonl seq 8) after sort_keys.
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

import odoo  # noqa: E402
from odoo.tools import json_default  # noqa: E402

LANGS = ('en_US', 'fr_FR')


def body_for(env, lang):
    # webclient.py:57-60
    mods = env.registry._init_modules.union(odoo.tools.config['server_wide_modules'])
    installed = env['res.lang'].sudo().get_installed()
    assert lang in {code for code, _ in installed}, f'{lang} is not an installed language'
    # ir_http.py:541-565 and :567-580
    translations_per_module, lang_params = env['ir.http']._get_translations_for_webclient(mods, lang)
    translation_cache = {
        'lang_parameters': lang_params,
        'modules': translations_per_module,
        'lang': lang,
        'multi_lang': len(installed) > 1,
    }
    digest = hashlib.sha1(json.dumps(translation_cache, sort_keys=True, default=json_default).encode()).hexdigest()
    # cross-check with Odoo's own (ormcached) method
    assert digest == env['ir.http']._get_web_translations_hash(mods, lang), 'hash mismatch against ir.http'
    body = {'lang': lang, 'hash': digest, **translation_cache}
    return json.loads(json.dumps(body, default=json_default))  # frozendict/tuple -> dict/list


def main():
    out_dir = os.path.join(_odoo.OUT, 'translations')
    index = {}
    with _odoo.env() as env:
        for lang in LANGS:
            body = body_for(env, lang)
            path = _odoo.write_json(os.path.join(out_dir, f'{lang}.json'), body)
            n = sum(len(m['messages']) for m in body['modules'].values())
            index[lang] = {'hash': body['hash'], 'file': f'{lang}.json', 'messages': n}
            print(f'{path}: hash={body["hash"]} modules={len(body["modules"])} messages={n}')
    _odoo.write_json(os.path.join(out_dir, 'index.json'), index)


if __name__ == '__main__':
    main()
