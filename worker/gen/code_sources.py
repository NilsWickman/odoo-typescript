"""Which modules' Python code calls `_()` with a given source text, for `translate()` calls in the port that do not
name their module (src/models/util.ts).

Odoo's `_()` (odoo/odoo/tools/translate.py:981-989 get_translation, :1006-1040 _get_translation_source) translates
with the .po table of the module the calling code belongs to: the frame's `__name__` `odoo.addons.<module>...`, and
`base` for the server's own code under odoo/odoo/ (translate.py get_translated_module). The port knows the text but
not always the Odoo file it was ported from. This scans the Python sources (ast, no execution) of every module
installed in the template, plus l10n_se (the overlay poc_erp_se), for calls `_("...")`, `_lt("...")` and
`<expr>._("...")` whose first argument is a string literal (and a field's plain-string `falsy_value_label=`, which
fields.py translates as base), and writes out/<template>/lang/code_sources.json:
{source: [modules]}. translate() uses it only when every listed module's table gives the same translation; a text
found in no module, or translated differently by two of them, still refuses.

  GEN_TEMPLATE=poc_erp GEN_DB=<a copy of poc_erp> ../.venv/bin/python gen/code_sources.py
"""
import ast, collections, os, pathlib
import _odoo

_odoo.boot()
import odoo.sql_db  # noqa: E402

ROOT = pathlib.Path(_odoo.ROOT)
with odoo.sql_db.db_connect(_odoo.DB).cursor() as cr:
    cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name")
    modules = {r[0] for r in cr.fetchall()} | {"l10n_se"}

found = collections.defaultdict(set)


def scan(path, module):
    tree = ast.parse(path.read_text(encoding="utf-8"), str(path))
    for n in ast.walk(tree):
        # a field's plain-string falsy_value_label: fields.py:1106-1107 `env._(label)` runs in odoo/orm/fields.py, so
        # its module is base (an `_lt(...)` label is found below with its own module)
        if isinstance(n, ast.Call):
            for kw in n.keywords:
                if kw.arg == "falsy_value_label" and isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                    found[kw.value.value].add("base")
        if not (isinstance(n, ast.Call) and n.args and isinstance(n.args[0], ast.Constant) and isinstance(n.args[0].value, str)):
            continue
        f = n.func
        if (isinstance(f, ast.Name) and f.id in ("_", "_lt")) or (isinstance(f, ast.Attribute) and f.attr == "_"):
            found[n.args[0].value].add(module)


for m in sorted(modules):
    d = next((p for p in (ROOT / "odoo/addons" / m, ROOT / "odoo/odoo/addons" / m) if p.is_dir()), None)
    if d is None:
        raise SystemExit(f"module {m} not found under odoo/addons or odoo/odoo/addons")
    for p in sorted(d.rglob("*.py")):
        if "tests" not in p.relative_to(d).parts:
            scan(p, m)
core = ROOT / "odoo/odoo"
for p in sorted(core.rglob("*.py")):
    rel = p.relative_to(core).parts
    if rel[0] != "addons" and "tests" not in rel:
        scan(p, "base")
out = {k: sorted(v) for k, v in sorted(found.items())}
path = _odoo.write_json(os.path.join(_odoo.OUT, "lang", "code_sources.json"), out)
print(path, len(modules), "modules", len(out), "sources", sum(len(v) > 1 for v in out.values()), "in several modules")
