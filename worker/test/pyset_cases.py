# The expectations of src/models/pyset.test.ts: list(set(ids)) and set().update(set(ids)) of CPython 3.12 (the oracle's .venv).
#   .venv/bin/python worker/test/pyset_cases.py > worker/test/pyset_cases.json
import random, json
random.seed(6)
cases = []
for n in list(range(1, 40)) + [50, 64, 100, 150, 300]:
    for spread in (n * 2, 400, 5000, 100000):
        ids = random.sample(range(1, spread + n + 1), n)
        s = set(ids)
        a = set(); a.update(s)
        cases.append([ids, list(s), list(a)])
# collisions as in the reconciliation of lines (ids close together and multiples of 8)
for base in (3, 241, 1000):
    ids = [base + 8 * k for k in range(12)]
    s = set(ids); a = set(); a.update(s)
    cases.append([ids, list(s), list(a)])
print(json.dumps(cases))
