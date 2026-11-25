"""SQL table queries of the models whose `_table_sql` is a query (`_auto = False` reports, odoo/odoo/orm/models.py:531):
rendered with Odoo's own code for the template, per language, as superuser in the main company.
Run: GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/table_sql.py -> gen/out[/<template>]/table_sql.json:
  {model: {"renders": {"<lang>/<uid>/<company>": {"code": <SQL with %s>, "params": [...]}}, "today": "<sentinel date>"}}
(internal users only; tuples are psycopg2-adapted lists for `IN %s`)
The port substitutes the render date with its database's date and refuses any other difference."""
import datetime
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _odoo  # noqa: E402

TODAY = datetime.date(2001, 2, 3)  # a sentinel: replaced by the request's date in the port


def main():
    from unittest.mock import patch
    import odoo
    from odoo.models import BaseModel
    with _odoo.env() as env, patch.object(odoo.fields.Date, 'today', staticmethod(lambda *a, **k: TODAY)), \
            patch.object(odoo.fields.Date, 'context_today', staticmethod(lambda *a, **k: TODAY)):
        out = {}
        langs = [code for code, _ in env['res.lang'].get_installed()]
        users = env['res.users'].with_context(active_test=False).search([('share', '=', False)])
        for name in sorted(env.registry.models):
            cls = type(env[name])
            if env[name]._abstract or cls._table_sql is BaseModel._table_sql:
                continue
            per = {}
            for lang in langs:
                for user in users:
                  for cid in user.company_ids.ids:
                    try:
                        sql = env[name].with_user(user).with_context(lang=lang, allowed_company_ids=[cid])._table_sql
                    except Exception as e:  # noqa: BLE001
                        per[f'{lang}/{user.id}/{cid}'] = {'error': repr(e)[:200]}
                        continue
                    code, raw_params, _flush = sql._sql_tuple
                    params = [p.isoformat() if isinstance(p, (datetime.date, datetime.datetime)) else p for p in raw_params]
                    per[f'{lang}/{user.id}/{cid}'] = {'code': code, 'params': params}
            out[name] = {'renders': per, 'today': TODAY.isoformat()}
    path = os.path.join(_odoo.OUT, 'table_sql.json')
    with open(path, 'w') as f:
        json.dump(out, f, indent=0, sort_keys=True, default=str)
    print(path, list(out))


if __name__ == '__main__':
    main()
