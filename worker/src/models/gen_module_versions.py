"""Emit src/models/module_versions.json: `ir.module.module.get_module_info(name).get('version')` of every module of
the database (odoo/odoo/addons/base/models/ir_module.py:171-175, :217-220), computed with Odoo's own Manifest.
Run from the repo root: .venv/bin/python worker/src/models/gen_module_versions.py <db names...>"""
import json, os, subprocess, sys
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "..", "odoo"))
from odoo.tools import config  # noqa: E402
from odoo.modules import module as M  # noqa: E402

root = os.path.join(HERE, "..", "..", "..", "odoo")
# the vendored OCA repositories too (B6): their modules get a record from update_list on the site
oca = os.path.join(HERE, "..", "..", "..", "oca")
config["addons_path"] = ",".join([os.path.join(root, "odoo", "addons"), os.path.join(root, "addons"),
                                  *sorted(os.path.join(oca, r) for r in os.listdir(oca) if os.path.isdir(os.path.join(oca, r)))])
M.initialize_sys_path()
names = set()
for db in sys.argv[1:]:
    out = subprocess.run(["docker", "exec", "odoo-port-pg", "psql", "-U", "odoo", "-d", db, "-Atc", "select name from ir_module_module"],
                         capture_output=True, text=True, check=True).stdout
    names.update(n for n in out.split() if n)
# and the modules update_list creates (gen/module_list.py `new`), which no template database has
names.update(json.load(open(os.path.join(HERE, "..", "..", "gen", "out", "poc_erp", "module_list.json"))).get("new", {}))
versions = {}
for name in sorted(names):
    info = M.Manifest.for_addon(name, display_warning=False)
    versions[name] = info.get("version") if info else None
json.dump(versions, open(os.path.join(HERE, "module_versions.json"), "w"), indent=0, sort_keys=True)
print(len(versions), sum(v is None for v in versions.values()))
