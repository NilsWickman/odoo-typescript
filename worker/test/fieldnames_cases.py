# The expectations of src/web/pystrset.test.ts: expressions of view attributes in Odoo's XML (at least two names) and
# list(get_expression_field_names(expr)) of CPython 3.12 with the oracle's seed, run from the repository root:
#   PYTHONHASHSEED=0 .venv/bin/python worker/test/fieldnames_cases.py > worker/test/fieldnames_cases.json
import sys, json, random, re, pathlib
sys.path.insert(0, 'odoo')
from odoo.tools.view_validation import get_expression_field_names
from lxml import etree
ATTRS = re.compile(r'^(invisible|readonly|required|column_invisible|domain|context|decoration-\w+)$')
seen = {}
for f in sorted(pathlib.Path('odoo/addons').glob('*/views/*.xml')) + sorted(pathlib.Path('odoo/addons').glob('*/report/*.xml')):
    try:
        tree = etree.parse(str(f))
    except Exception:
        continue
    for el in tree.iter():
        if not isinstance(el.tag, str): continue
        for k, v in el.attrib.items():
            if ATTRS.match(k) and v.strip() and v not in seen:
                try:
                    names = list(get_expression_field_names(v))
                except Exception:
                    continue
                if len(names) >= 2:
                    seen[v] = names
items = sorted(seen.items())
random.seed(1)
random.shuffle(items)
print('[\n' + ',\n'.join(json.dumps([e, n]) for e, n in items[:400]) + '\n]')
print(len(items), file=sys.stderr)
