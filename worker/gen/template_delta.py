"""template_delta.py <template> <base>: reduce gen/out/<template>/ (the full outputs of the generators run with
GEN_TEMPLATE=<template> on a database of <base> plus extra modules) to what differs from gen/out/<base>/, the overlay
src/orm/overlay.ts merges over the base's files at runtime (packaged under /__gen/<template>/ by gen/filestore.py
and start.sh, not in the bundle). Then records the template in gen/out/templates.json with `dir` <base> and
`overlay` <template>, its module set read from the generator database (GEN_DB).

Per file, the entries of the map that holds the per-model data (`models` for models.json, precompute.json,
check_company.json, public_methods.json and button_names.json; the top level for table_sql.json, write_defaults.json and
field_order.json, whose base is src/models/field_order_<base>.json) that are new or differ; whole entries, never a
field-level patch. The `db` key of the generator database is dropped. A file without difference is left empty ({}).

Run after the generators: GEN_TEMPLATE=poc_erp_se GEN_DB=<copy> .venv/bin/python worker/gen/template_delta.py poc_erp_se poc_erp
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

FILES = {'models.json': 'models', 'precompute.json': 'models', 'check_company.json': 'models',
         'public_methods.json': 'models', 'table_sql.json': None, 'write_defaults.json': None, 'field_order.json': None,
         'button_names.json': 'models', 'copy_overrides.json': 'models'}


def normalized(value, base_value=None):
    """What the generators would have written in a checkout whose `odoo/` is not a link (run/mkworktree.sh links it to
    another checkout's: their source paths go through it), and, for a table_sql render, the base's renders of the
    languages the generator database does not have active (only its own are rendered): neither is the overlay's."""
    if isinstance(value, str):
        for rel, repl in PATHS:
            if value.startswith(rel):
                return repl + value[len(rel):]
        return value
    if isinstance(value, list):
        return [normalized(v) for v in value]
    if isinstance(value, dict):
        out = {k: normalized(v, base_value.get(k) if isinstance(base_value, dict) else None) for k, v in value.items()}
        if isinstance(base_value, dict) and 'renders' in out and isinstance(base_value.get('renders'), dict):
            langs = {k.split('/')[0] for k in out['renders']}
            out['renders'] = {**{k: v for k, v in base_value['renders'].items() if k.split('/')[0] not in langs}, **out['renders']}
        return out
    return value


_real_odoo = os.path.realpath(os.path.join(_odoo.ROOT, 'odoo'))
# longest first: relative to odoo/ (onchange_methods' sources), then to the repository root (write_defaults')
PATHS = sorted({(os.path.relpath(_real_odoo, os.path.join(_odoo.ROOT, 'odoo')) + '/', ''),
                (os.path.relpath(_real_odoo, _odoo.ROOT) + '/', 'odoo/')} - {('./', ''), ('odoo/', 'odoo/')},
               key=lambda p: -len(p[0]))


def models_of(out, template, modules):
    """The models the modules introduce or extend: in the full models.json, those whose `modules` name one of them."""
    with open(os.path.join(out, template, 'models.json'), encoding='utf-8') as f:
        full = json.load(f)['models']
    return {m for m, d in full.items() if set(d.get('modules') or ()) & modules}


def main():
    template, base = sys.argv[1], sys.argv[2]
    out = os.path.join(_odoo.ROOT, 'worker', 'gen', 'out')
    # --models-of a,b (compiler/sitebuild.py, D24): the generators ran on a build database, not on the base's own: an
    # entry of a model the new modules leave alone that differs is the build database's data (a label in its users'
    # language, a SQL view rendered with its ids), not the overlay's; only the modules' models are kept, and a SQL view
    # (table_sql) of theirs refuses: it is rendered with the build database's users, companies and ids
    only = None
    if '--models-of' in sys.argv:
        only = models_of(out, template, set(sys.argv[sys.argv.index('--models-of') + 1].split(',')))
    for name, key in FILES.items():
        full_path = os.path.join(out, template, name)
        base_path = os.path.join(_odoo.ROOT, 'worker', 'src', 'models', f'field_order_{base}.json') if name == 'field_order.json' \
            else os.path.join(out, base, name)
        with open(full_path, encoding='utf-8') as f:
            full = json.load(f)
        with open(base_path, encoding='utf-8') as f:
            basej = json.load(f)
        if key is None:
            full = {k: normalized(v, basej.get(k)) for k, v in full.items()}
            delta = {k: v for k, v in full.items() if k not in ('db', 'odoo_commit') and basej.get(k) != v}
            removed = [k for k in basej if k not in full and k not in ('db', 'odoo_commit')]
        else:
            full[key] = {k: normalized(v, basej[key].get(k)) for k, v in full[key].items()}
            delta = {key: {k: v for k, v in full[key].items() if basej[key].get(k) != v}}
            removed = [k for k in basej[key] if k not in full[key]]
            if key == 'models' and name in ('public_methods.json', 'button_names.json') and full.get('common') != basej.get('common'):
                raise SystemExit(f'{name}: the common names differ, not an overlay of {base}')
        if removed:
            raise SystemExit(f'{name}: entries of {base} missing in {template} ({removed[:5]}): not an overlay')
        if only is not None:
            if key is None:
                delta = {k: v for k, v in delta.items() if k in only}
            else:
                delta = {key: {k: v for k, v in delta[key].items() if k in only}}
            if name == 'table_sql.json' and delta:
                raise SystemExit(f'table_sql.json: {sorted(delta)[:5]}: a SQL view of the new modules, rendered on the build database (not ported)')
        _odoo.write_json(full_path, delta)
        n = len(delta[key]) if key else len(delta)
        print(f'{full_path}: {n} entries differ from {base}')
    path = os.path.join(out, 'templates.json')
    with _odoo.env() as env:
        env.cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name")
        modules = [r[0] for r in env.cr.fetchall()]
    # read, change and write under a lock: two site builds at once each wrote the file they had read before the
    # other's entry (poc_erp_bh's lost to poc_erp_nz's, 2026-11-12)
    import fcntl
    with open(path + '.lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
        data[template] = {'dir': base, 'overlay': template, 'modules': modules}
        _odoo.write_json(path, data)
    print(f'{path}: {template} over {base}, {len(modules)} modules')


if __name__ == '__main__':
    main()
