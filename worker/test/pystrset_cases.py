# The expectations of src/web/pystrset.test.ts: random unions of string sets and the order CPython 3.12 iterates them
#   PYTHONHASHSEED=0 .venv/bin/python worker/test/pystrset_cases.py > worker/test/pystrset_cases.json
import json, random, string
random.seed(7)
cases = []
words = [''.join(random.choice(string.ascii_lowercase + '_') for _ in range(random.randint(1, 14))) for _ in range(400)]
for _ in range(120):
    groups = [random.sample(words, random.randint(0, 12)) for _ in range(random.randint(1, 6))]
    s = set()
    for g in groups:
        t = set()
        for w in g: t.add(w)
        s |= t
    cases.append([groups, list(s)])
print(json.dumps(cases, separators=(',', ':')))
