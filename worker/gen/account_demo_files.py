"""account_demo_files.py: the files account's demo data reads (`file_read`, account/demo/account_demo.py:16-19), base64
by path, for src/models/account_demo.ts: the Worker cannot read the addons. Written into each overlay template's
directory (packaged under /__gen/ with it, not in the bundle). Run: python3 worker/gen/account_demo_files.py
"""
import base64
import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'worker', 'gen', 'out')
FILES = ['account/static/demo/in_invoice_yourcompany_demo_1.pdf', 'account/static/demo/in_invoice_yourcompany_demo_2.pdf',
         'account/static/demo/bank_statement_one_month_old.pdf']


def main():
    data = {}
    for path in FILES:
        with open(os.path.join(ROOT, 'odoo', 'addons', path), 'rb') as f:
            data[path] = base64.b64encode(f.read()).decode()
    with open(os.path.join(OUT, 'templates.json'), encoding='utf-8') as f:
        templates = json.load(f)
    for t in templates.values():
        if t.get('overlay'):
            with open(os.path.join(OUT, t['overlay'], 'account_demo_files.json'), 'w', encoding='utf-8') as f:
                f.write(json.dumps(data, sort_keys=True, indent=1) + '\n')
            print(t['overlay'], len(data), 'files')


if __name__ == '__main__':
    main()
