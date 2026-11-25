"""Boot Odoo's registry for the generators, the way `odoo-bin shell -d <db>` does (odoo/odoo/cli/shell.py,
Shell.shell): parse the config, open the registry, build a superuser Environment with res.users.context_get().

Every generator imports `env()` from here and runs with the repo root as cwd so the relative `addons_path` and
`data_dir` of run/odoo.conf resolve (filestore: run/filestore/filestore/<db>). The database is a scratch copy
(default dev_gen, made from poc_corpus with harness/dbs.py); poc_corpus itself is never opened writable.
"""
import contextlib
import json
import os
import sys

# Odoo's own metadata is not fully deterministic across processes: res_partner.py:132 sorts the tz selection with
# a key that maps every 'Etc/*' zone to '_', so their relative order is the iteration order of the set
# `all_timezones`, which changes with Python's per-process hash seed (the oracle shows the same drift between
# restarts). Pin the seed so re-running a generator reproduces its file byte for byte.
if os.environ.get('PYTHONHASHSEED') != '0':
    os.execve(sys.executable, [sys.executable, *sys.argv], {**os.environ, 'PYTHONHASHSEED': '0'})

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
# In a worktree odoo/ and the venvs are links to the main checkout (run/mkworktree.sh), and Python reports a module's
# file by its real path. `rel` gives a path as this checkout names it, so a generator's output does not depend on
# the checkout it ran in (write_defaults.json and onchange_methods.json had `../../personal/odoo-ts/odoo/...`).
_LINKED = [(os.path.realpath(os.path.join(ROOT, d)), os.path.join(ROOT, d)) for d in ('odoo', '.venv', '.venv-harness')
           if os.path.islink(os.path.join(ROOT, d))]


def rel(path, start=None):
    """`path` relative to `start` (default ROOT), through this checkout's own odoo/ and venvs."""
    path = os.path.abspath(path)
    for real, here in _LINKED:
        if path == real or path.startswith(real + os.sep):
            path = here + path[len(real):]
            break
    return os.path.relpath(path, start or ROOT)
# Per-template outputs (C1 runs on poc_erp, S1 on poc_corpus): GEN_TEMPLATE=poc_erp writes gen/out/poc_erp/ from the
# scratch copy dev_gen_poc_erp; the default (poc_corpus) keeps gen/out/ and dev_gen as before.
TEMPLATE = os.environ.get('GEN_TEMPLATE', 'poc_corpus')
# GEN_OUT: another directory (compiler/batch.py writes each module's capture under results/, not gen/out)
OUT = os.environ.get('GEN_OUT') or (os.path.join(ROOT, 'worker', 'gen', 'out') if TEMPLATE == 'poc_corpus' else
                                    os.path.join(ROOT, 'worker', 'gen', 'out', TEMPLATE))
DB = os.environ.get('GEN_DB', 'dev_gen' if TEMPLATE == 'poc_corpus' else f'dev_gen_{TEMPLATE}')

os.chdir(ROOT)
sys.path.insert(0, os.path.join(ROOT, 'odoo'))

import odoo  # noqa: E402  (also applies odoo/odoo/_monkeypatches/mimetypes.py: .js -> text/javascript)
# odoo/odoo/init.py patch_init before anything imports lxml, as odoo-bin (`import odoo.cli`) and so the oracle have it:
# the patches hook the first import of their module. `from odoo.tools import config` first imported lxml unpatched, and
# html_sanitize then dropped role/aria-* (odoo/_monkeypatches/lxml.py), where the server keeps them: lunch's act_window
# help was captured without them, and the port, which keeps them, refused its translation (measured 2026-11-15)
import odoo.init  # noqa: E402,F401
from odoo.tools import config  # noqa: E402

_booted = False


def boot():
    """config.parse_config like odoo/odoo/cli/shell.py Shell.init, without starting the HTTP server."""
    global _booted
    if _booted:
        return
    # the site's addons: Odoo's, then the vendored OCA repositories (oca/<repo>, ACCEPTANCE B6), as proofs/oracle.sh
    oca = sorted(os.path.join('oca', r) for r in os.listdir(os.path.join(ROOT, 'oca'))
                 if os.path.isdir(os.path.join(ROOT, 'oca', r))) if os.path.isdir(os.path.join(ROOT, 'oca')) else []
    args = ['-c', os.path.join(ROOT, 'run', 'odoo.conf'), '-d', DB]
    if oca:
        args += ['--addons-path', ','.join(['odoo/addons', 'odoo/odoo/addons', *oca])]
    config.parse_config(args, setup_logging=False)
    _booted = True


@contextlib.contextmanager
def env(db=None, commit=False):
    """Yield a superuser Environment on `db` (odoo/odoo/cli/shell.py Shell.shell). Rolls back unless commit=True."""
    boot()
    from odoo.modules.registry import Registry
    registry = Registry(db or DB)
    with registry.cursor() as cr:
        uid = odoo.api.SUPERUSER_ID
        ctx = odoo.api.Environment(cr, uid, {})['res.users'].context_get()
        e = odoo.api.Environment(cr, uid, ctx)
        try:
            yield e
            if commit:
                cr.commit()
            else:
                cr.rollback()
        except BaseException:
            cr.rollback()
            raise


def write_models_json(path, data):
    """models.json, and beside it the models.pack the Worker bundles (models_pack.py, src/gen_models.ts). The JSON is
    what the other generators, the compiler and the tests read: ASCII, the other keys on line one, then one model a
    line, sorted, each line that model's compact JSON, so a change shows as the lines of the models it touched and the
    file is 17 MB instead of 23 for poc_erp."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    dump = lambda v: json.dumps(v, sort_keys=True, ensure_ascii=True, allow_nan=False, separators=(',', ':'))  # noqa: E731
    head = dump({k: v for k, v in data.items() if k != 'models'})
    lines = [dump(name) + ':' + dump(model) for name, model in sorted(data['models'].items())]
    with open(path, 'w', encoding='ascii') as f:
        f.write(head[:-1] + (',' if len(head) > 2 else '') + '"models":{\n' + ',\n'.join(lines) + '\n}}\n')
    import models_pack  # beside this file: the form of the same metadata that the Worker bundles
    models_pack.write(path)
    return path


def write_json(path, data, ascii=False):
    """Deterministic JSON: sorted keys, 1-space indent, no NaN, UTF-8 kept (`ascii`: every character above 127 as a
    \\uXXXX escape instead, the same value), trailing newline."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    text = json.dumps(data, sort_keys=True, indent=1, ensure_ascii=ascii, allow_nan=False)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)
        f.write('\n')
    return path
