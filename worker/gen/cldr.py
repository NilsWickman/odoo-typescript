"""cldr.py -> gen/out/cldr.json: the babel (CLDR) data Odoo uses for en_US, fr_FR and sv_SE (ruling O1, PORTING_odoo.md 8).

Run: .venv/bin/python worker/gen/cldr.py

Source: babel 2.10.3 in .venv (.venv/lib/python3.12/site-packages/babel/), locale data files
babel/locale-data/<locale>.dat with the inheritance chain <ll_CC>.dat -> <ll>.dat -> root.dat (babel/localedata.py
load(); the chain and each file's sha256 are recorded under `source`). Values are read through babel.Locale,
exactly the objects Odoo's code reads:
  months.format.wide / abbreviated, months.stand_alone.*     Locale.months        babel/core.py
  days.format.wide / abbreviated, days.stand_alone.*         Locale.days          (keys 0=Monday .. 6=Sunday)
  quarters.format.wide / abbreviated, quarters.stand_alone.* Locale.quarters      (keys 1..4)
  day_periods.format.abbreviated (am/pm)                     Locale.day_periods
  date_formats / time_formats / datetime_formats             Locale.*_formats     (full, long, medium, short)
  week.first_week_day (0=Monday .. 6=Sunday), week.min_week_days, weekend_start, weekend_end
                                                              Locale.first_week_day, min_week_days (babel/core.py;
                                                              read by odoo/odoo/tools/date_utils.py:449 weeknumber)
Odoo patterns rendered with babel (what web_read_group labels use):
  read_group_display_format    odoo/odoo/orm/models.py:344 READ_GROUP_DISPLAY_FORMAT, formatted by
                               odoo/addons/web/models/models.py:1449-1456 (babel.dates.format_datetime /
                               format_date with locale = get_lang(env).code); 'week' labels are replaced by
                               f"W{week} {year:04}" from date_utils.weeknumber (web/models/models.py:1459-1464)
  posix_to_ldml                odoo/odoo/tools/misc.py:562: the res.lang strftime date_format/time_format as LDML,
                               used by odoo.tools.misc.format_date/format_datetime (misc.py:1419, :1490)
  samples                      each pattern rendered for 2026-10-28 13:05:09 and 2026-01-01 (a W53/W1 edge) so a
                               port can be checked against babel without running Python
res_lang: the res_lang rows of the database (dev_gen = poc_corpus copy) for comparison: Odoo's week_start is
1=Monday .. 7=Sunday (res_lang.py:114) while babel's first_week_day is 0=Monday .. 6=Sunday.
"""
import datetime
import hashlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

import babel  # noqa: E402
import babel.dates  # noqa: E402
import babel.localedata  # noqa: E402
from odoo.orm.models import READ_GROUP_DISPLAY_FORMAT  # noqa: E402
from odoo.tools.date_utils import weeknumber  # noqa: E402
from odoo.tools.misc import posix_to_ldml  # noqa: E402

LANGS = ('en_US', 'fr_FR', 'sv_SE')
SAMPLE_DT = datetime.datetime(2026, 10, 28, 13, 5, 9)
SAMPLES = (SAMPLE_DT, datetime.datetime(2026, 1, 1, 0, 0, 0), datetime.datetime(2025, 12, 29, 0, 0, 0))


def _names(mapping):
    return {str(k): v for k, v in sorted(mapping.items())}


def _formats(mapping):
    return {k: mapping[k].pattern for k in sorted(mapping)}


def _chain(code):
    """The .dat files babel merges for `code` (babel/localedata.py load(): parent chain down to root)."""
    chain = []
    name = code
    while name:
        path = os.path.join(babel.localedata._dirname, f'{name}.dat')
        chain.append({'file': os.path.relpath(path, _odoo.ROOT),
                      'sha256': hashlib.sha256(open(path, 'rb').read()).hexdigest()})
        name = babel.localedata.get_parent(name) if hasattr(babel.localedata, 'get_parent') else (
            'root' if name != 'root' and '_' not in name else (name.split('_')[0] if '_' in name else None))
    return chain


def locale_data(code, lang_row):
    loc = babel.Locale.parse(code)
    out = {
        'months': {ctx: {w: _names(loc.months[ctx][w]) for w in ('wide', 'abbreviated', 'narrow')}
                   for ctx in ('format', 'stand-alone')},
        'days': {ctx: {w: _names(loc.days[ctx][w]) for w in ('wide', 'abbreviated', 'short', 'narrow')}
                 for ctx in ('format', 'stand-alone')},
        'quarters': {ctx: {w: _names(loc.quarters[ctx][w]) for w in ('wide', 'abbreviated', 'narrow')}
                     for ctx in ('format', 'stand-alone')},
        'day_periods': {ctx: {w: _names(loc.day_periods[ctx][w]) for w in sorted(loc.day_periods[ctx])}
                        for ctx in sorted(loc.day_periods)},
        'date_formats': _formats(loc.date_formats),
        'time_formats': _formats(loc.time_formats),
        'datetime_formats': {k: v for k, v in sorted(loc.datetime_formats.items())},
        'week': {
            'first_week_day': loc.first_week_day,
            'min_week_days': loc.min_week_days,
            'weekend_start': loc.weekend_start,
            'weekend_end': loc.weekend_end,
        },
        # babel/lists.py format_list (odoo/odoo/tools/i18n.py format_list): the 'standard' patterns
        'list_patterns': {'standard': dict(loc.list_patterns['standard'])},
        'read_group_display_format': dict(READ_GROUP_DISPLAY_FORMAT),
        'posix_to_ldml': {
            'date_format': posix_to_ldml(lang_row['date_format'], loc),
            'time_format': posix_to_ldml(lang_row['time_format'], loc),
        },
        'samples': {},
        'source': _chain(code),
    }
    for dt in SAMPLES:
        key = dt.strftime('%Y-%m-%d %H:%M:%S')
        s = {}
        for gran, fmt in READ_GROUP_DISPLAY_FORMAT.items():
            s[f'read_group:{gran}:datetime'] = babel.dates.format_datetime(dt, format=fmt, tzinfo=None, locale=code)
            if gran != 'hour':  # date fields have no hour granularity (web/models/models.py:1454)
                s[f'read_group:{gran}:date'] = babel.dates.format_date(dt.date(), format=fmt, locale=code)
        year, week = weeknumber(loc, dt.date())
        s['read_group:week:label'] = f'W{week} {year:04}'  # web/models/models.py:1464
        s['date_format'] = babel.dates.format_date(dt.date(), format=out['posix_to_ldml']['date_format'], locale=code)
        s['time_format'] = babel.dates.format_time(dt, format=out['posix_to_ldml']['time_format'], locale=code)
        out['samples'][key] = s
    return out


def main():
    with _odoo.env() as env:
        env.cr.execute("""SELECT code, name, iso_code, url_code, active, direction, date_format, time_format,
                                 week_start, grouping, decimal_point, thousands_sep
                            FROM res_lang WHERE code IN %s ORDER BY code""", [LANGS])
        rows = {r['code']: dict(r) for r in env.cr.dictfetchall()}
        assert set(rows) == set(LANGS), rows.keys()
        out = {
            'babel_version': babel.__version__,
            'babel_path': os.path.relpath(os.path.dirname(babel.__file__), _odoo.ROOT),
            'locales': {code: locale_data(code, rows[code]) for code in LANGS},
            'res_lang': rows,
        }
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'cldr.json'), out)
    for code in LANGS:
        loc = out['locales'][code]
        print(f'{code}: first_week_day={loc["week"]["first_week_day"]} min_week_days={loc["week"]["min_week_days"]}'
              f' res_lang.week_start={rows[code]["week_start"]} month10={loc["months"]["format"]["wide"]["10"]}'
              f' Q4={loc["quarters"]["format"]["abbreviated"]["4"]} sample={loc["samples"]["2026-10-28 13:05:09"]}')
    print(path)


if __name__ == '__main__':
    main()
