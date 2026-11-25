# The expectations of src/models/pyhashset.test.ts: hash() of naive datetimes and of (start, stop) tuples, and the
# order of a set of ranges built as calendar_recurrence.py `_range_calculation` and `_reconcile_events` build it
# (set(generator), a filtered set(generator), then set(that set)), with CPython 3.12 and the oracle's seed:
#   PYTHONHASHSEED=0 .venv/bin/python worker/test/pyhashset_cases.py > worker/test/pyhashset_cases.json
import json, random, datetime
random.seed(5)
F = '%Y-%m-%d %H:%M:%S'
hashes = []
for _ in range(40):
    a = datetime.datetime(random.randint(1990, 2040), random.randint(1, 12), random.randint(1, 28), random.randint(0, 23), random.randint(0, 59), random.randint(0, 59))
    b = a + datetime.timedelta(minutes=random.randint(1, 600))
    hashes.append([a.strftime(F), b.strftime(F), str(hash(a) & (2**64 - 1)), str(hash((a, b)) & (2**64 - 1))])
sets = []
for _ in range(60):
    start = datetime.datetime(random.randint(2025, 2028), random.randint(1, 12), random.randint(1, 28), random.randint(5, 18), random.choice([0, 30]))
    step = datetime.timedelta(days=random.choice([1, 2, 7, 14, 30, 365]))
    dur = datetime.timedelta(minutes=random.choice([30, 45, 60, 90]))
    n = random.randint(1, 40)
    ranges = set((start + i * step, start + i * step + dur) for i in range(n))
    cut = start + random.randint(0, n // 3) * step
    kept = set((x, y) for x, y in ranges if x.date() >= cut.date())
    final = set(kept)
    sets.append([[(start + i * step).strftime(F) for i in range(n)], dur.seconds // 60, cut.strftime(F), [x.strftime(F) for x, y in final]])
print(json.dumps({"hashes": hashes, "sets": sets}, separators=(',', ':')))
