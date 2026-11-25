"""copy_overrides.py -> gen/out/<template>/copy_overrides.json: the models whose `copy` is not BaseModel's generic one
(odoo/orm/models.py:4954-5032 `copy_data` + `copy`), so the Worker's generic copy (src/web/save.ts) refuses them unless
it has a port of the override, instead of duplicating them differently from Odoo.

For each model: the classes (module.Class) that define `copy` or `copy_data` in the MRO above BaseModel, and the
fields whose `copy` attribute is a callable (`vals[name] = field.copy(record)`, models.py:4999-5000).

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/copy_overrides.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402


def main():
    from odoo.orm.models import BaseModel
    out = {}
    with _odoo.env() as env:
        for name in sorted(env.registry.models):
            cls = type(env[name])
            methods = []
            for meth in ('copy', 'copy_data'):
                for klass in cls.__mro__:
                    if klass is BaseModel:
                        break
                    if meth in vars(klass):
                        methods.append(f'{meth}:{klass.__module__}')
            callables = sorted(f for f, field in env[name]._fields.items() if callable(field.copy))
            if methods or callables:
                out[name] = {'methods': methods, 'callable_copy_fields': callables}
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'copy_overrides.json'), {'models': out})
    print(path, len(out), 'models')


if __name__ == '__main__':
    main()
