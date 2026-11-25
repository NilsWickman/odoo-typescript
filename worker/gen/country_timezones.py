"""country_timezones.py -> gen/out/country_timezones.json: `odoo.modules.db.country_timezones()` (db.py:268-297),
tzdb's zone.tab as the oracle's Python reads it (tzdata or the OS zoneinfo), for resource's `res.company._compute_tz`
(resource/models/res_company.py:18-27: a country with exactly one zone sets the company's tz).

Run: .venv/bin/python worker/gen/country_timezones.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402
from odoo.modules.db import country_timezones  # noqa: E402

print(_odoo.write_json(os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', 'country_timezones.json'), dict(country_timezones())))
