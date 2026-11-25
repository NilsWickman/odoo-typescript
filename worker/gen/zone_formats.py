"""zone_formats.py -> gen/out/zone_formats.json: babel's localized GMT format (`Locale.zone_formats['gmt']`, e.g.
"GMT%s", fr "UTC%s") for the locales of gen/out/cldr.json, which babel.dates.get_timezone_gmt (width 'long', the
pattern letters ZZZZ) fills with '%+03d:%02d' % divmod(offset seconds, 3600) -> (hours, seconds // 60).

Run: .venv/bin/python worker/gen/zone_formats.py
Also writes worker/test/tracking_format_cases.json: babel's renderings of mail_track_mixin.py:625-640
`_format_tracking_date` / `_format_tracking_datetime` for those locales over a few dates and time zones, the
expectations of src/mail/tracking_format.test.ts.
"""
import datetime, json, pathlib
import babel, babel.dates
import pytz
from babel import Locale

ROOT = pathlib.Path(__file__).resolve().parents[2]
locales = sorted(json.loads((ROOT / "worker/gen/out/cldr.json").read_text())["locales"])
out = {"babel_version": babel.__version__, "locales": {l: {"gmt": Locale.parse(l).zone_formats["gmt"]} for l in locales}}
(ROOT / "worker/gen/out/zone_formats.json").write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
cases = []
for l in locales:
    loc = Locale.parse(l)
    dfmt = babel.dates.get_date_format(locale=loc)
    tfmt = f"{babel.dates.get_datetime_format(locale=loc).format(babel.dates.get_time_format(format='short', locale=loc), dfmt)} (ZZZZ)"
    for d in ("2026-01-01", "2026-11-06", "2026-03-29", "2026-12-31"):
        cases.append(["date", l, d, "", babel.dates.format_date(datetime.date.fromisoformat(d), format=dfmt, locale=loc)])
    for v in ("2026-11-06 20:15:09", "2026-03-29 00:30:00", "2026-07-01 11:59:59", "2026-07-01 12:00:00", "2026-12-31 23:59:00"):
        for tz in ("Europe/Brussels", "Europe/Stockholm", "UTC", "America/New_York", "Asia/Kolkata", "America/St_Johns"):
            dt = pytz.utc.localize(datetime.datetime.fromisoformat(v)).astimezone(pytz.timezone(tz))
            cases.append(["datetime", l, v, tz, babel.dates.format_datetime(dt, format=tfmt, tzinfo=pytz.timezone(tz), locale=loc)])
(ROOT / "worker/test/tracking_format_cases.json").write_text("[\n" + ",\n".join(json.dumps(c, ensure_ascii=False) for c in cases) + "\n]\n")
print(f"{len(locales)} locales, {len(cases)} cases")
