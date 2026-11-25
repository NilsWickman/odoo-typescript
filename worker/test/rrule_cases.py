# The expectations of src/models/rrule.test.ts: random rules of the shapes calendar_recurrence.py `_get_rrule` builds,
# their occurrences and str() with dateutil 2.8.2 (the oracle's .venv):
#   .venv/bin/python worker/test/rrule_cases.py > worker/test/rrule_cases.json
import json, random, datetime
from dateutil import rrule
random.seed(11)
FREQ = {'daily': rrule.DAILY, 'weekly': rrule.WEEKLY, 'monthly': rrule.MONTHLY, 'yearly': rrule.YEARLY}
WD = [rrule.MO, rrule.TU, rrule.WE, rrule.TH, rrule.FR, rrule.SA, rrule.SU]
cases = []
for _ in range(250):
    freq = random.choice(list(FREQ))
    dt = datetime.datetime(random.randint(2024, 2028), random.randint(1, 12), random.randint(1, 28), random.randint(0, 23), random.choice([0, 15, 30, 45]), random.choice([0, 0, 33]))
    if random.random() < 0.15:
        # the end of a month (a leap day included)
        for day in (31, 30, 29):
            try:
                dt = dt.replace(day=day)
                break
            except ValueError:
                pass
    spec = {'freq': freq, 'dtstart': dt.strftime('%Y-%m-%d %H:%M:%S'), 'interval': random.choice([1, 1, 2, 3]), 'wkst': None,
            'count': None, 'until': None, 'byweekday': None, 'bynweekday': None, 'bymonthday': None}
    params = dict(dtstart=dt, interval=spec['interval'])
    if freq == 'weekly':
        days = sorted(random.sample(range(7), random.randint(1, 4)))
        random.shuffle(days)
        spec['byweekday'] = days
        params['byweekday'] = tuple(WD[d] for d in days)
        spec['wkst'] = random.choice([0, 6, 5, random.randint(0, 6)])
        params['wkst'] = WD[spec['wkst']]
    elif freq == 'monthly':
        if random.random() < 0.5:
            spec['bymonthday'] = random.choice([1, 15, 28, 29, 30, 31, random.randint(1, 31)])
            params['bymonthday'] = spec['bymonthday']
        else:
            wd, n = random.randint(0, 6), random.choice([1, 2, 3, 4, -1])
            spec['bynweekday'] = [wd, n]
            params['byweekday'] = WD[wd](n)
    if random.random() < 0.6:
        spec['count'] = random.randint(1, 25)
        params['count'] = spec['count']
    else:
        until = (dt + datetime.timedelta(days=random.randint(0, 250))).date()
        spec['until'] = until.strftime('%Y-%m-%d')
        params['until'] = datetime.datetime.combine(until, datetime.time.max)
    r = rrule.rrule(FREQ[freq], **params)
    cases.append([spec, [d.strftime('%Y-%m-%d %H:%M:%S') for d in r], str(r)])
print(json.dumps(cases, separators=(',', ':')))
