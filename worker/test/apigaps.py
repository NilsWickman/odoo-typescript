"""Diagnostic (run from harness/ with CF_TRACK_PORT and HARNESS_CLOCK set, a worker on that port): replay the frozen API corpus against the cf track and group the failing cases by the port's actual answer."""
import collections, json, re, sys, concurrent.futures
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[2] / "harness"))
import apicorpus, common

BASE = common.track_url("cf")

def work(args):
    idx, g = args
    db, window, answers = apicorpus.run_group(g, BASE, f"g{idx:03d}")
    out = []
    for c, a in zip(g["cases"], answers):
        d = apicorpus.differs(apicorpus.norm(c["expected"], c["db"], c["window"], c["model"]), apicorpus.norm(a, db, window, c["model"]))
        if d is None:
            continue
        err = a.get("error") if isinstance(a, dict) else None
        msg = ((err or {}).get("data") or {}).get("message") if isinstance(err, dict) else None
        reason = f"ERR {msg}" if msg else f"DIFF {d}"
        out.append((c["model"], c["user"], c["id"], reason[:300]))
    return out

groups = [g for g in apicorpus._groups_of(apicorpus.load_cases())]
with concurrent.futures.ProcessPoolExecutor(3) as ex:
    rows = [r for out in ex.map(work, list(enumerate(groups))) for r in out]
json.dump(rows, open("/tmp/apigaps/rows.json", "w"), indent=0)
norm = lambda s: re.sub(r"\d+", "N", s)[:140]
cnt = collections.Counter(norm(r[3]) for r in rows)
for k, v in cnt.most_common(80):
    print(v, k)
