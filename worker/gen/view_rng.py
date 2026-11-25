"""Odoo's view schemas for the Worker: odoo/odoo/addons/base/rng/<type>_view.rng and common.rng, which `valid_view`
(odoo/odoo/tools/view_validation.py:282-325, `schema_valid`) validates calendar, graph, pivot, search, list and
activity archs against with lxml's RelaxNG in `_check_xml` (odoo/odoo/addons/base/models/ir_ui_view.py:519-527).

Writes out/view_rng.json: {"files": {<file name>: <text verbatim>}, "sha256": {<file name>: <sha256>}};
src/modules/relaxng.ts compiles a view type's schema (with its include of common.rng) at first use. No registry is
needed, so this does not boot Odoo.
"""
import hashlib, json, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "odoo/odoo/addons/base/rng"
files = {p.name: p.read_text(encoding="utf-8") for p in sorted(SRC.glob("*.rng"))}
out = {"source": "odoo/odoo/addons/base/rng", "files": files,
       "sha256": {k: hashlib.sha256(v.encode()).hexdigest() for k, v in files.items()}}
dst = ROOT / "worker/gen/out/view_rng.json"
dst.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
print(f"{dst.relative_to(ROOT)}: {len(files)} files")
