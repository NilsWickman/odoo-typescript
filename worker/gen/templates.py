"""templates.py -> gen/out/templates.json: the installed module set of each corpus template whose per-template
outputs exist (gen/out/ for poc_corpus, gen/out/<template>/ otherwise; _odoo.py GEN_TEMPLATE).

Run: GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/templates.py   (merges that template's entry)

The Worker picks a database's generated data (models.json, translations, bundles) by comparing its
`ir_module_module.state = 'installed'` names (the registry's `_init_modules`, odoo/odoo/modules/loading.py) with
these lists; a database matching none of them gets NotPorted.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

PATH = os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', 'templates.json')


def main():
    data = {}
    if os.path.exists(PATH):
        with open(PATH, encoding='utf-8') as f:
            data = json.load(f)
    with _odoo.env() as env:
        env.cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name")
        modules = [r[0] for r in env.cr.fetchall()]
    data[_odoo.TEMPLATE] = {'dir': '' if _odoo.TEMPLATE == 'poc_corpus' else _odoo.TEMPLATE, 'modules': modules}
    _odoo.write_json(PATH, data)
    print(f'{PATH}: {_odoo.TEMPLATE} {len(modules)} modules')


if __name__ == '__main__':
    main()
