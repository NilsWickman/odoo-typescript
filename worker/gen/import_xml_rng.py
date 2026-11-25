"""Odoo's data-file schema for the Worker: odoo/odoo/import_xml.rng, which convert_xml_import (odoo/odoo/tools/convert.py
:792-797) validates every XML data file against with lxml's RelaxNG before loading it.

Writes out/import_xml_rng.json: {"source", "sha256", "rng"} with the schema's text verbatim; src/modules/relaxng.ts
compiles it at first use. No registry is needed, so this does not boot Odoo.
"""
import hashlib, json, os, pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "odoo/odoo/import_xml.rng"
text = SRC.read_text(encoding="utf-8")
out = {"source": "odoo/odoo/import_xml.rng", "sha256": hashlib.sha256(text.encode()).hexdigest(), "rng": text}
dst = ROOT / "worker/gen/out/import_xml_rng.json"
dst.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8")
print(f"{dst.relative_to(ROOT)}: {len(text)} chars, sha256 {out['sha256'][:12]}")
