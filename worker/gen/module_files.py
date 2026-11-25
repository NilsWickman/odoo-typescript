"""module_files.py: the files a module install reads from the addons path, for the modules an overlay template adds
to its base (gen/out/templates.json: poc_erp_se is poc_erp plus l10n_se). The Worker cannot read the addons on disk;
src/modules/install.ts loads these instead, as odoo/modules/loading.py `load_module_graph` reads them:

  manifest:  the manifest as Odoo's `Manifest.for_addon` gives it (defaults filled in: data, demo, hooks, version),
             with `latest_version` = `adapt_version(version)` (written to ir_module_module at the end of the install)
  files:     the text of each data and demo file the manifest names, by its path in the module
  po:        the module's i18n/*.po files by language code (`_update_translations` loads those of installed languages)

Run: .venv/bin/python worker/gen/module_files.py   (no database; writes gen/out/<overlay>/module_files.json)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

KEYS = ('name', 'version', 'depends', 'auto_install', 'data', 'demo', 'pre_init_hook', 'post_init_hook',
        'uninstall_hook', 'external_dependencies', 'countries', 'installable')


def module_files(module, po_langs=None):
    """The manifest, data and demo files and .po files (all, or those of `po_langs`) of a module."""
    from odoo.modules.module import Manifest, adapt_version
    manifest = Manifest.for_addon(module)
    path = manifest.path
    m = {k: manifest.get(k) for k in KEYS}
    m['auto_install'] = sorted(m['auto_install']) if m['auto_install'] else m['auto_install']
    m['latest_version'] = adapt_version(manifest['version'])
    files = {}
    for kind in ('data', 'demo'):
        for rel in manifest[kind]:
            with open(os.path.join(path, rel), encoding='utf-8') as f:
                files[rel] = f.read()
    # convert.py:137-147 a <field file="module/path"> reads the file from the addons path (`file_open`): the files the
    # data and demo XML name, as base64 (src/modules/convert.ts), only when there are some
    binaries = {}
    import base64
    import re
    from odoo.tools.misc import file_path
    for rel, text in files.items():
        if not rel.endswith('.xml'):
            continue
        for ref in re.findall(r'<field\b[^>]*\bfile="([^"]+)"', text):
            if ref not in binaries:
                with open(file_path(ref), 'rb') as f:
                    binaries[ref] = base64.b64encode(f.read()).decode()
    po = {}
    i18n = os.path.join(path, 'i18n')
    if os.path.isdir(i18n):
        for fn in sorted(os.listdir(i18n)):
            if fn.endswith('.po') and (po_langs is None or fn[:-3] in po_langs):
                with open(os.path.join(i18n, fn), encoding='utf-8') as f:
                    po[fn[:-3]] = f.read()
    return {'manifest': m, 'files': files, 'po': po, **({'binaries': binaries} if binaries else {})}


def main():
    _odoo.boot()
    out = os.path.join(_odoo.ROOT, 'worker', 'gen', 'out')
    with open(os.path.join(out, 'templates.json'), encoding='utf-8') as f:
        templates = json.load(f)
    for name, t in sorted(templates.items()):
        if not t.get('overlay'):
            continue
        base = next(b for b in templates.values() if b.get('dir') == t['dir'] and not b.get('overlay'))
        extra = sorted(set(t['modules']) - set(base['modules']))
        result = {module: module_files(module) for module in extra}
        print(f'{t["overlay"]}: {", ".join(extra)}: '
              + ', '.join(f'{k} {len(v["files"])} files, {len(v["po"])} po' for k, v in result.items()))
        _odoo.write_json(os.path.join(out, t['overlay'], 'module_files.json'), result)


if __name__ == '__main__':
    main()
