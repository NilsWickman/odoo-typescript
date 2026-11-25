"""mimetypes_table.py -> gen/out/mimetypes.json: Python's `mimetypes` module as the oracle's interpreter has it after
`import odoo` (CPython 3.12 defaults, the host's /etc/mime.types, and Odoo's odoo/odoo/_monkeypatches/mimetypes.py
add_type calls), for `mimetypes.guess_type(name)` in ir.attachment `_compute_mimetype` (ir_attachment.py:469-489).

Keys: `types_map` (strict, `mimetypes.types_map`), `suffix_map`, `encodings_map`; `files` are the knownfiles that
existed when it was generated (the host's mime.types changes the answers).

Run: .venv/bin/python worker/gen/mimetypes_table.py
"""
import mimetypes
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402,F401  (import odoo: the monkeypatches)
import odoo.init  # noqa: E402,F401  (odoo/odoo/init.py:32-33 patch_init, as odoo-bin)

mimetypes.guess_type('x.js')  # the lazy patch runs when mimetypes is initialised
assert mimetypes.guess_type('x.woff')[0] == 'application/font-woff', mimetypes.guess_type('x.woff')
out = {
    'types_map': dict(sorted(mimetypes.types_map.items())),
    'suffix_map': dict(sorted(mimetypes.suffix_map.items())),
    'encodings_map': dict(sorted(mimetypes.encodings_map.items())),
    'files': [f for f in mimetypes.knownfiles if os.path.exists(f)],
}
print(_odoo.write_json(os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', 'mimetypes.json'), out))
