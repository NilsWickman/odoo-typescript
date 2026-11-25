"""onchange_methods.py -> gen/out[/<template>]/onchange_methods.json: Odoo's `@api.onchange` methods per model and field.

Run: .venv/bin/python worker/gen/onchange_methods.py                            (poc_corpus, scratch copy dev_gen)
     GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/onchange_methods.py       (poc_erp, dev_gen_poc_erp)
     GEN_TEMPLATE=poc_erp_se .venv/bin/python worker/gen/onchange_methods.py    (poc_erp + l10n_se, dev_gen_poc_erp_se)

Source (Odoo 20, commit dd5d3718): odoo/odoo/orm/models.py `_onchange_methods` (:594-627), read on every model of the
registry. For each field the list holds the methods in the order `onchange()` applies them
(web/models/models.py:2368-2374 `_apply_onchange_methods` iterates `_onchange_methods[field]`): the `@api.onchange`
methods in `inspect.getmembers` order (sorted by attribute name), then the `change_default` method (:614-623), named
`<change_default>` here. Each method name maps to the module and source line of the function the registry class
resolves (the last override in the MRO; an override without the decorator is not an onchange method any more).

`onchange_override`: the modules (MRO order) whose class of the model overrides `onchange` itself (the base is
web/models/models.py:2189); the port refuses such a model's onchange unless it registers its own.

The port refuses an onchange whose field has a method in this list that it has not registered
(src/orm/onchange_methods.ts `onchangeSteps`), instead of silently skipping it.
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

CHANGE_DEFAULT = '<change_default>'


def where(func):
    func = inspect.unwrap(func)
    try:
        path = inspect.getsourcefile(func)
        line = inspect.getsourcelines(func)[1]
    except (OSError, TypeError):
        return None
    return f'{_odoo.rel(path, os.path.join(_odoo.ROOT, "odoo"))}:{line}'


with _odoo.env() as env:
    out = {}
    for name in sorted(env.registry):
        model = env[name]
        methods = model._onchange_methods
        fields = {}
        defs = {}
        for fname, funcs in methods.items():
            names = []
            for func in funcs:
                if getattr(func, 'func', None) is not None and getattr(func.func, '__name__', '') == 'onchange_default':
                    names.append(CHANGE_DEFAULT)
                    continue
                names.append(func.__name__)
                defs[func.__name__] = {'fields': list(func._onchange), 'source': where(func)}
            fields[fname] = names
        # an override of `onchange` itself (web/models/models.py:2189 is the base): the modules whose class defines it
        overrides = [c._module for c in type(model).mro() if 'onchange' in vars(c) and getattr(c, '_module', None) not in (None, 'web')
                     and c.__module__.startswith('odoo.addons.')]
        if fields or overrides:
            out[name] = {'fields': fields, 'methods': defs}
            if overrides:
                out[name]['onchange_override'] = overrides
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'onchange_methods.json'),
                            {'_source': 'worker/gen/onchange_methods.py', 'models': out})
    n = sum(len(m['methods']) for m in out.values())
    cd = sum(1 for m in out.values() for f in m['fields'].values() if CHANGE_DEFAULT in f)
    print(f'{path}: {len(out)} models, {n} onchange methods, {cd} change_default fields')
