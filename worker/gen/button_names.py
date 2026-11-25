"""button_names.py -> gen/out/<template>/button_names.json: the verdict of ir_ui_view.py:2063-2097 `_validate_tag_button`
for a `type="object"` button on each model, so the Worker validates a view's buttons as Odoo does (src/modules/ir_ui_view.ts).

  func = getattr(name_manager.model, name, None)        # the model: an empty recordset
  if not func: "<name> is not a valid action on <model>"
  if name.startswith('_') or func._api_private: "<name> on <model> is private and cannot be called from a button"

A name is listed when `getattr` on the empty recordset is truthy: under `private` or `ok`; a name whose getattr raises is
listed under `error` (the Worker refuses it). Any other name is "not a valid action" (fields of an empty recordset are
falsy). Output: `common` (the lists every model has) and `models` (model -> the other names), sorted.

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/button_names.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402


def verdicts(model):
    out = {'ok': set(), 'private': set(), 'error': set()}
    for name in set(dir(type(model))) | set(model._fields):
        try:
            func = getattr(model, name, None)
            truthy = bool(func)
        except Exception:  # noqa: BLE001 - the view validation would raise it too: the Worker refuses the name
            out['error'].add(name)
            continue
        if not truthy:
            continue
        if name.startswith('_') or getattr(func, '_api_private', False):
            out['private'].add(name)
        else:
            out['ok'].add(name)
    return out


def main():
    with _odoo.env() as env:
        per = {m: verdicts(env[m].with_context(lang=None)) for m in sorted(env.registry.models)}
    common = {k: set.intersection(*(v[k] for v in per.values())) for k in ('ok', 'private', 'error')}
    out = {'common': {k: sorted(v) for k, v in common.items()},
           'models': {m: {k: sorted(v[k] - common[k]) for k in ('ok', 'private', 'error') if v[k] - common[k]} for m, v in per.items()}}
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'button_names.json'), out)
    print(path, {k: len(v) for k, v in common.items()}, 'common', len(per), 'models')


if __name__ == '__main__':
    main()
