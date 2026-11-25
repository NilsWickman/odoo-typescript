"""pg_errors.py -> gen/out/pg_errors.json: the psycopg2 exception class of every SQLSTATE.

Run: .venv/bin/python worker/gen/pg_errors.py

Source: psycopg2.errors.lookup(code) of the installed psycopg2 (the class Odoo's serialize_exception names,
odoo/odoo/http/dispatcher.py:78-91: `f'{module}.{name}'`, module `psycopg2.errors`), for every code in
psycopg2.errorcodes. No database is opened.
"""
import json
import os

import psycopg2
import psycopg2.errorcodes
import psycopg2.errors

out = {}
for name in dir(psycopg2.errorcodes):
    code = getattr(psycopg2.errorcodes, name)
    if not (isinstance(code, str) and len(code) == 5 and name.isupper()):
        continue
    try:
        cls = psycopg2.errors.lookup(code)
    except KeyError:
        continue
    out[code] = f'{cls.__module__}.{cls.__name__}'
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'pg_errors.json')
with open(path, 'w', encoding='utf-8') as f:
    f.write(json.dumps({'psycopg2': psycopg2.__version__.split()[0], 'classes': out}, sort_keys=True, indent=1) + '\n')
print(path, len(out))
