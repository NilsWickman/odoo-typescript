"""The Python-only attributes res.config.settings' default_get reads (odoo/odoo/addons/base/models/res_config.py
:177-228 `_get_classified_fields`, :237-283 `default_get`), for the port's default_get (src/models/settings_defaults.ts).

Writes out/<template>/settings_fields.json:
  fields: {name: {kind: default|group|module|config|other, type, implied_group, group (xmlids, default
          'base.group_user'), config_parameter, default_model, comodel, default}}
          `default` is {"const": value} when the field's default is a constant (fields.py:545-547 wraps a constant in
          `lambda model: value`, read from the closure), "callable" for any other default, null without one.
  overrides: {"get_values": [modules], "default_get": [modules]}: the classes in the MRO below base's ResConfigSettings
          that define the method (by their Python module), so the port refuses an override it has not ported.
  data:   PEPPOL_LIST and the country codes Stripe and Mercado Pago support (read by the Settings computes).

  GEN_TEMPLATE=poc_erp GEN_DB=<a copy of poc_erp> ../.venv/bin/python gen/settings_fields.py
"""
import os
import _odoo

MODEL = 'res.config.settings'


def const_default(field):
    d = field.default
    if d is None:
        return None
    code = getattr(d, '__code__', None)
    if code is not None and code.co_filename.endswith('odoo/orm/fields.py') and d.__closure__ and code.co_freevars == ('value',):
        v = d.__closure__[0].cell_contents
        if v is None or isinstance(v, (bool, int, float, str)):
            return {'const': v}
    return 'callable'


with _odoo.env() as env:
    Model = env[MODEL]
    out = {}
    for name, field in sorted(Model._fields.items()):
        if name.startswith('default_'):
            kind = 'default'
        elif name.startswith('group_'):
            kind = 'group'
        elif name.startswith('module_'):
            kind = 'module'
        elif getattr(field, 'config_parameter', None):
            kind = 'config'
        else:
            kind = 'other'
        out[name] = {
            'kind': kind,
            'type': field.type,
            'implied_group': getattr(field, 'implied_group', None) if kind == 'group' else None,
            'group': getattr(field, 'group', 'base.group_user').split(',') if kind == 'group' else None,
            'config_parameter': getattr(field, 'config_parameter', None) if kind == 'config' else None,
            'default_model': getattr(field, 'default_model', None) if kind == 'default' else None,
            'comodel': getattr(field, 'comodel_name', None),
            'default': const_default(field),
        }
    overrides = {}
    for method in ('get_values', 'default_get'):
        mods = []
        for cls in type(Model).__mro__:
            if method in cls.__dict__ and cls.__module__.startswith('odoo.addons.'):
                mod = cls.__module__.split('.')[2]
                if not (mod == 'base' and cls.__module__.endswith('res_config')):
                    mods.append(mod)
        overrides[method] = sorted(set(mods))
    # constants and per-country values the Settings computes read (src/models/settings_computes.ts):
    # account/models/company.py PEPPOL_LIST, and res.country.is_stripe_supported_country /
    # is_mercado_pago_supported_country (payment/models/res_country.py `_compute_provider_support`) per country code
    from odoo.addons.account.models.company import PEPPOL_LIST
    countries = env['res.country'].with_context(active_test=False).search([])
    data = {
        'peppol_list': sorted(PEPPOL_LIST),
        'stripe_countries': sorted(c.code for c in countries if c.is_stripe_supported_country),
        'mercado_pago_countries': sorted(c.code for c in countries if c.is_mercado_pago_supported_country),
    }
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'settings_fields.json'), {'fields': out, 'overrides': overrides, 'data': data})
    kinds = {}
    for f in out.values():
        kinds[f['kind']] = kinds.get(f['kind'], 0) + 1
    print(path, kinds, overrides)
