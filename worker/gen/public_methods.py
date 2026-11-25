"""public_methods.py -> gen/out/<template>/public_methods.json: the names `get_public_method` (odoo/orm/models.py:199-225)
finds callable on each model class, so the Worker answers Odoo's AttributeError "The method 'm.f' does not exist" for a
name no class defines, and keeps NotPorted for the ones that exist but are not ported (src/http/methods.ts).

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/public_methods.py

Output: `common` (callable public names every model class has) and `models` (model -> the other names), sorted.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402


def names(cls):
    # models.py:211-214: `getattr(cls, name, None)` callable; private names never reach it (AccessError first)
    return {n for n in dir(cls) if not n.startswith('_') and callable(getattr(cls, n, None))}


def main():
    with _odoo.env() as env:
        per = {m: names(type(env[m])) for m in sorted(env.registry.models)}
    common = set.intersection(*per.values())
    out = {'common': sorted(common), 'models': {m: sorted(s - common) for m, s in per.items()}}
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'public_methods.json'), out)
    print(path, len(common), 'common', sum(len(v) for v in out['models'].values()), 'per model', len(per), 'models')


if __name__ == '__main__':
    main()
