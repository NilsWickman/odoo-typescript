"""Generate library metadata, never contact numbers or expected RPC results.

Source: installed phonenumbers.phonemetadata, used by phonenumberutil.py
region_code_for_number, _number_type_helper and _format_nsn (O5).
"""
import os
import phonenumbers as phone
from phonenumbers.phonemetadata import PhoneMetadata
import _odoo

TYPES = ('fixed_line', 'mobile', 'toll_free', 'premium_rate', 'shared_cost',
         'voip', 'personal_number', 'pager', 'uan', 'voicemail')

def desc(d):
    return {'pattern': d.national_number_pattern, 'lengths': d.possible_length, 'local_lengths': d.possible_length_local_only} if d else None

def metadata(m):
    return {
        'general': desc(m.general_desc), 'leading': m.leading_digits,
        'country_code': m.country_code, 'international_prefix': m.international_prefix,
        'national_prefix': m.national_prefix_for_parsing, 'national_transform': m.national_prefix_transform_rule,
        'types': [desc(getattr(m, t)) for t in TYPES if getattr(m, t)],
        'formats': [{'pattern': f.pattern, 'format': f.format,
                     'leading': f.leading_digits_pattern[-1] if f.leading_digits_pattern else None}
                    for f in (m.intl_number_format or m.number_format)],
    }

out = {'version': phone.__version__, 'calling_codes': phone.COUNTRY_CODE_TO_REGION_CODE,
       'regions': {r: metadata(PhoneMetadata.metadata_for_region(r)) for r in sorted(phone.SUPPORTED_REGIONS)},
       'non_geographic': {c: metadata(PhoneMetadata.metadata_for_nongeo_region(c)) for c in sorted(phone.COUNTRY_CODES_FOR_NON_GEO_REGIONS)}}
print(_odoo.write_json(os.path.join(_odoo.OUT, 'phone.json'), out))
