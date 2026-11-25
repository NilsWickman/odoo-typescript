"""controller_overrides.py -> gen/out/<template>/controller_overrides.json: the HTTP controller methods the template's
new modules override (a controller class of a module outside the base template that inherits another module's
controller and redefines one of its methods: account_payment_custom's CustomerPortal `_get_common_page_view_values`,
l10n_ma's portal `_prepare_address_form_values`). The hand port serves the base's routes and helpers itself, so such an
override would silently change nothing: compiler/sitebuild.py refuses a site with any.

From every subclass of odoo.http.Controller (odoo/http/routing_map.py: `children_classes` holds only the direct ones, the
routing map reaches the overrides through __subclasses__), with the modules' code imported by the registry load. The base template's modules: GEN_BASE (default poc_erp) in
gen/out/templates.json.

Run: GEN_TEMPLATE=poc_erp_pc GEN_DB=<generator db> GEN_BASE=poc_erp .venv/bin/python worker/gen/controller_overrides.py
"""
import inspect
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402


def addon_of(cls):
    parts = (cls.__module__ or '').split('.')
    return parts[2] if len(parts) > 2 and parts[:2] == ['odoo', 'addons'] else None


def main():
    from odoo import http
    with open(os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', 'templates.json'), encoding='utf-8') as f:
        base = set(json.load(f)[os.environ.get('GEN_BASE', 'poc_erp')]['modules'])
    overrides = []
    with _odoo.env() as env:
        env.cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed'")
        installed = {r[0] for r in env.cr.fetchall()}
        new = installed - base
        # every controller class (http/routing_map.py `children_classes` holds only the direct subclasses of Controller;
        # an override is a subclass of one of them, which Odoo's routing reaches through __subclasses__)
        seen, todo, classes = set(), [http.Controller], []
        while todo:
            c = todo.pop()
            for sub in c.__subclasses__():
                if sub not in seen:
                    seen.add(sub)
                    todo.append(sub)
                    classes.append(sub)
        for cls in sorted(classes, key=lambda k: (k.__module__, k.__qualname__)):
            module = addon_of(cls)
            if module not in new:
                continue
            parents = [k for k in cls.__mro__[1:] if addon_of(k) and addon_of(k) != module and k is not http.Controller]
            for name, fn in sorted(vars(cls).items()):
                if not inspect.isfunction(fn):
                    continue
                over = [f'{k.__module__}.{k.__qualname__}' for k in parents if name in vars(k)]
                if over:
                    overrides.append({'module': module, 'class': f'{cls.__module__}.{cls.__qualname__}', 'method': name,
                                      'overrides': over, 'route': bool(getattr(fn, 'original_routing', None) or getattr(fn, 'routing', None))})
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'controller_overrides.json'), {'overrides': overrides})
    print(path, len(overrides), 'controller method overrides')


if __name__ == '__main__':
    main()
