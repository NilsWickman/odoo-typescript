"""orm_methods.py -> gen/out[/<template>]/orm_methods.json: the models whose public ORM read methods are Odoo's own.

Run: .venv/bin/python worker/gen/orm_methods.py                          (poc_corpus, scratch copy dev_gen)
     GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/orm_methods.py     (poc_erp, scratch copy dev_gen_poc_erp)

Source (Odoo 20, commit dd5d3718): odoo/odoo/orm/models.py `read` (:2798), `search` / `search_count` /
`search_fetch` / `_search`, `search_read` (:5232), `_read_format`, `fetch`, `_fetch_query`. For each model and each
public method, the method and every helper it relies on is looked up in the class's MRO: the method is listed for
the model only when all of them are defined by odoo.orm.models.BaseModel itself (no module overrides them), so the
port's generic implementation (src/orm/model.ts) answers exactly as Odoo. Access checks (`check_access`,
`_check_access`, `_filtered_access`) and the record-rule helpers must not be overridden either.

`display_name`: the models whose `display_name` is not BaseModel's `_compute_display_name` (models.py:1504, the
`_rec_name`'s display value): a module overrides the method or the field's compute. The port refuses to make up
their display name unless it has a `displayName` hook (src/orm/model.ts).
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

# `_check_company_auto` is a class flag read only by write and create (models.py:3989, :4232), not a read helper
ACCESS = ['check_access', '_check_access', '_filtered_access', 'has_access', '_has_access',
          '_flush_search', '_where_calc', '_order_to_sql', '_generate_order_by', '_read_group_orderby']
READ = ['read', '_read_format', 'fetch', '_fetch_query', '_fetch_field', '_determine_fields_to_fetch'] + ACCESS
SEARCH = ['search', 'search_fetch', '_search'] + ACCESS
METHODS = {
    'read': READ,
    'search': SEARCH,
    'search_count': ['search_count'] + SEARCH,
    'search_read': ['search_read'] + SEARCH + READ,
    # models.py:924-937 `export_data` -> `_export_rows` (:839-922), which reads through the record cache (fetch), not
    # through `read` or `_read_format` (an override of those, e.g. account_move.py:3855 `read`, does not change it)
    'export_data': ['export_data', '_export_rows'] + [h for h in READ if h not in ('read', '_read_format')],
    # models.py:943-1119 `load` -> `_extract_records`, `_convert_records`, `_load_records` (create/write listed apart)
    'load': ['load', '_extract_records', '_convert_records', '_load_records', '_load_records_create', '_load_records_write'] + SEARCH,
    'create': ['create'],
    'write': ['write'],
}


def definer(cls, name):
    for klass in cls.__mro__:
        if name in klass.__dict__:
            return klass
    return None


def main():
    from odoo.orm.models import BaseModel
    out = {}
    display = []
    with _odoo.env() as env:
        for name in sorted(env.registry.models):
            cls = type(env[name])
            if env[name]._abstract or not env[name]._auto:
                ok = []
            else:
                ok = [m for m, helpers in METHODS.items() if all(definer(cls, h) in (BaseModel, None) for h in helpers)]
                # an active field searched through an SQL expression (`compute_sql`, account.report.active): the
                # implicit active_test of every search uses it, and that is not ported
                active = env[name]._fields.get(env[name]._active_name or '')
                if active is not None and getattr(active, 'compute_sql', None):
                    ok = [m for m in ok if m == 'read']
            if ok:
                out[name] = ok
            field = env[name]._fields.get('display_name')
            if field is not None and (field.compute != '_compute_display_name' or definer(cls, '_compute_display_name') is not BaseModel):
                display.append(name)
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'orm_methods.json'),
                            {'odoo_commit': 'dd5d371863dd96f640e4a4b970d8437bb9861cba', 'db': _odoo.DB, 'models': out,
                             'display_name_override': display})
    print(path, len(out), 'models', len(display), 'display_name overrides', {m: sum(m in v for v in out.values()) for m in METHODS})


if __name__ == '__main__':
    main()
