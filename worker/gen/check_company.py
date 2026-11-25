"""check_company.py -> gen/out[/<template>]/check_company.json: what `_check_company` needs per model.

Run: .venv/bin/python worker/gen/check_company.py              (poc_corpus, scratch copy dev_gen)
     GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/check_company.py   (poc_erp, scratch copy dev_gen_poc_erp)

Source (Odoo 20, commit dd5d3718), odoo/odoo/orm/models.py:
  auto        `_check_company_auto` (:493), the models whose create (:4232) and write (:3989) call `_check_company`
  regular     relational fields with `check_company` that are not company dependent (:3370-3376), in `_fields` order
  property    the company dependent ones (:3375)
  domain      the model's `_check_company_domain` (:3339) as one of: "default" (BaseModel's), "parent_of"
              (models.check_company_domain_parent_of, :162), "companies_parent_of" (check_companies_domain_parent_of,
              :181), "res.users" (base res_users.py:181), or the qualified name of any other function
  field_has_company_id / field_has_company_ids   whether the model has those fields (:3386-3392)
Only models with `_check_company_auto` or that are the comodel of a checked field are listed.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

from odoo.orm import models as orm_models  # noqa: E402


def _domain_kind(cls):
    fn = getattr(cls, '_check_company_domain')
    fn = getattr(fn, '__func__', fn)
    if fn is orm_models.BaseModel._check_company_domain:
        return 'default'
    if fn is orm_models.check_company_domain_parent_of:
        return 'parent_of'
    if fn is orm_models.check_companies_domain_parent_of:
        return 'companies_parent_of'
    if fn.__module__ == 'odoo.addons.base.models.res_users' and fn.__name__ == '_check_company_domain':
        return 'res.users'
    return f'{fn.__module__}.{fn.__qualname__}'


def main():
    out = {}
    with _odoo.env() as env:
        wanted = set()
        for name in sorted(env.registry.models):
            model = env[name]
            regular = [f for f, fld in model._fields.items() if fld.relational and fld.check_company and not fld.company_dependent]
            prop = [f for f, fld in model._fields.items() if fld.relational and fld.check_company and fld.company_dependent]
            if model._check_company_auto or regular or prop:
                out[name] = {'auto': bool(model._check_company_auto), 'regular': regular, 'property': prop}
                for f in regular + prop:
                    wanted.add(model._fields[f].comodel_name)
        for name in sorted(set(out) | wanted):
            model = env[name]
            entry = out.setdefault(name, {'auto': bool(model._check_company_auto), 'regular': [], 'property': []})
            entry['domain'] = _domain_kind(type(model))
            entry['has_company_id'] = 'company_id' in model._fields
            entry['has_company_ids'] = 'company_ids' in model._fields
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'check_company.json'), {'odoo_commit': 'dd5d371863dd96f640e4a4b970d8437bb9861cba', 'db': _odoo.DB, 'models': out})
    print(path, len(out), 'models', sum(1 for v in out.values() if v['auto']), 'auto')


if __name__ == '__main__':
    main()
