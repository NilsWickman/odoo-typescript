"""Source metadata for partner reads: base/res_partner.py identifier definitions
and Python translations from base/mail .po files. Never reads contact values.
"""
import os
import re
import _odoo
from odoo.tools import json_default
from odoo.tools.translate import code_translations
import json

with _odoo.env() as env:
    result = {}
    for lang in ('en_US', 'fr_FR', 'sv_SE'):
        partner = env['res.partner'].with_context(lang=lang)
        metadata = {key: partner._lazy_translate_additional_identifiers_metadata(value)
                    for key, value in partner._get_all_additional_identifiers_metadata().items()}
        serialized = json.dumps(metadata, default=json_default)
        # Function addresses are explicitly nondeterministic (harness N3).
        serialized = re.sub(r'(<function [^>]+ at )0x[0-9a-f]+', r'\g<1>0x0', serialized)
        result[lang] = {
            'identifiers': json.loads(serialized),
            'translations': {module: dict(code_translations.get_python_translations(module, lang))
                             for module in ('base', 'mail')},
        }
print(_odoo.write_json(os.path.join(_odoo.OUT, 'contacts.json'), result))
