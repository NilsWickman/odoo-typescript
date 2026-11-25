"""assets.py: copy the static/ tree of every installed module into worker/assets/<module>/static/... and write
worker/assets/MANIFEST.json.

Run: .venv/bin/python worker/gen/assets.py

Odoo serves /<module>/static/<path> straight from the addon directory (odoo/odoo/http/router.py:323 serve_static ->
odoo/odoo/http/stream.py:104 Stream.from_path): the module must be installed-or-loadable (root.static_path), the
mimetype is mimetypes.guess_type(path)[0] after odoo/odoo/_monkeypatches/mimetypes.py registered .js ->
text/javascript, .woff -> application/font-woff, .ttf -> application/x-font-ttf, .eot ->
application/vnd.ms-fontobject, .svg -> image/svg+xml, .webp -> image/webp; werkzeug then appends
"; charset=utf-8" to text/* and application/javascript (werkzeug.utils.get_content_type). Headers:
Cache-Control public, max-age=604800 (STATIC_CACHE, stream.py:24), Content-Disposition inline; filename=<basename>,
X-Content-Type-Options nosniff (stream.py:208), ETag "<int mtime>-<size>-<adler32 path>" (stream.py:121; not
reproducible from a copy, so not in the manifest).

Copied: everything under <module>/static/ except static/tests/ (test suites, never requested by the client) and
files over 25 MiB (Workers Static Assets limit; reported). Compiled bundles are not built from these at runtime
(they live in ir_attachment), so the tree is only the files the browser fetches by URL. Installed modules come
from ir_module_module.state = 'installed' of the database (dev_gen = poc_corpus copy). Of the other modules only the
`ir_module_module.icon` file is copied: Odoo serves every addon of the addons path, installed or not (router.py:172-178),
and the Apps kanban asks for those icons.

MANIFEST.json: {"<module>/static/<path>": {"size": bytes, "mimetype": guess_type or null}} sorted by path, plus
"_meta": {"modules": [...], "files", "bytes", "skipped": [...]}.
"""
import mimetypes
import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402  (imports odoo: applies the mimetypes monkeypatch)

from odoo.modules.module import get_module_path  # noqa: E402

ASSETS = os.path.join(_odoo.ROOT, 'worker', 'assets')
MAX_SIZE = 25 * 1024 * 1024
KEEP = {'README.txt', 'MANIFEST.json'}


def installed_modules(env):
    env.cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name")
    return [r[0] for r in env.cr.fetchall()]


def add_module_icons(env, manifest):
    """The icon of each module that is not installed, for the Apps kanban. Adds to the tree and to `manifest`."""
    env.cr.execute("SELECT name, icon FROM ir_module_module WHERE state != 'installed' AND icon LIKE '/%/static/%' ORDER BY name")
    for name, icon in env.cr.fetchall():
        key = icon.lstrip('/')
        module, rel = key.split('/', 1)
        path = get_module_path(module, display_warning=False)
        full = path and os.path.join(path, rel)
        if key in manifest or not full or not os.path.isfile(full):
            continue
        dst = os.path.join(ASSETS, key)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(full, dst)
        manifest[key] = {'size': os.path.getsize(full), 'mimetype': mimetypes.guess_type(full)[0]}


def write_manifest(manifest, copied_modules, skipped):
    total = sum(v['size'] for k, v in manifest.items() if k != '_meta')
    files = sum(1 for k in manifest if k != '_meta')
    manifest['_meta'] = {
        'modules': copied_modules,
        'files': files,
        'bytes': total,
        'skipped': skipped,
        'excluded': ['<module>/static/tests/'],
    }
    _odoo.write_json(os.path.join(ASSETS, 'MANIFEST.json'), manifest)
    return files, total


def main():
    with _odoo.env() as env:
        modules = installed_modules(env)
    # idempotent: drop previously copied trees (everything but the hand-written README and the manifest)
    for entry in os.listdir(ASSETS):
        if entry not in KEEP:
            shutil.rmtree(os.path.join(ASSETS, entry))
    manifest = {}
    skipped = []
    copied_modules = []
    for module in modules:
        src = os.path.join(get_module_path(module), 'static')
        if not os.path.isdir(src):
            continue
        copied_modules.append(module)
        for dirpath, dirnames, filenames in os.walk(src):
            rel_dir = os.path.relpath(dirpath, src)
            if rel_dir == '.':
                dirnames[:] = sorted(d for d in dirnames if d != 'tests')
            else:
                dirnames.sort()
            for fn in sorted(filenames):
                full = os.path.join(dirpath, fn)
                if not os.path.isfile(full) or os.path.islink(full):
                    skipped.append({'path': os.path.relpath(full, _odoo.ROOT), 'reason': 'not a regular file'})
                    continue
                size = os.path.getsize(full)
                rel = os.path.normpath(os.path.join('static', rel_dir, fn))
                key = f'{module}/{rel}'
                if size > MAX_SIZE:
                    skipped.append({'path': key, 'reason': f'{size} bytes > 25 MiB'})
                    continue
                dst = os.path.join(ASSETS, module, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.copyfile(full, dst)
                manifest[key] = {'size': size, 'mimetype': mimetypes.guess_type(full)[0]}
    with _odoo.env() as env:
        add_module_icons(env, manifest)
    files, total = write_manifest(manifest, copied_modules, skipped)
    print(f'{len(copied_modules)} modules, {files} files, {total} bytes, skipped {len(skipped)}')
    for s in skipped:
        print('skipped', s)
    types = {}
    for k, v in manifest.items():
        if k != '_meta':
            types[v['mimetype']] = types.get(v['mimetype'], 0) + 1
    print('mimetypes:', dict(sorted(types.items(), key=lambda kv: (-kv[1], str(kv[0])))))


if __name__ == '__main__':
    main()
