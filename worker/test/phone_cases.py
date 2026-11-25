# The expectations of src/models/phone.test.ts: canonicalPhone(number, region) is Odoo's phone_parse
# (odoo/addons/phone_validation/tools/phone_validation.py:17-58) formatted E164, False where it raises. The numbers are
# phonenumbers' own example numbers of every region and type, written as E164, as "+CC <national prefix><NSN>" (a
# national prefix kept after the country code, as a user types it: l10n_uk's demo company "+32 010 12 34 56"), in the
# national format with and without the region, and with the region of another country. Run from the repository root:
#   .venv/bin/python worker/test/phone_cases.py > worker/test/phone_cases.json
import json
import re
import sys
sys.path.insert(0, 'odoo')
import phonenumbers as p
from phonenumbers.phonemetadata import PhoneMetadata
from odoo.exceptions import UserError
import odoo.addons
odoo.addons.__path__.append('odoo/addons')
from odoo.addons.phone_validation.tools.phone_validation import phone_parse

TYPES = [p.PhoneNumberType.FIXED_LINE, p.PhoneNumberType.MOBILE, p.PhoneNumberType.TOLL_FREE]


def ref(number, region):
    try:
        return p.format_number(phone_parse(number, region), p.PhoneNumberFormat.E164)
    except (UserError, p.NumberParseException):
        return False


inputs = set()
for region in sorted(p.SUPPORTED_REGIONS):
    meta = PhoneMetadata.metadata_for_region(region)
    for t in TYPES:
        ex = p.example_number_for_type(region, t)
        if ex is None:
            continue
        nsn = p.national_significant_number(ex)
        inputs.add((p.format_number(ex, p.PhoneNumberFormat.E164), None))
        inputs.add((p.format_number(ex, p.PhoneNumberFormat.INTERNATIONAL), None))
        prefix = meta.national_prefix
        if prefix and re.fullmatch(r'\d+', prefix):
            inputs.add((f'+{ex.country_code} {prefix}{nsn}', None))
            inputs.add((f'+{ex.country_code} {prefix}{nsn}', region))
            inputs.add((f'+{ex.country_code} {prefix}{nsn}', 'GB' if region != 'GB' else 'FR'))
        inputs.add((p.format_number(ex, p.PhoneNumberFormat.NATIONAL), region))
inputs.add(('+32 010 12 34 56', None))
inputs.add(('+32 010 12 34 56', 'GB'))
print(json.dumps({'version': p.__version__, 'cases': [[n, r, ref(n, r)] for n, r in sorted(inputs, key=lambda x: (x[0], x[1] or ''))]}, indent=0))
