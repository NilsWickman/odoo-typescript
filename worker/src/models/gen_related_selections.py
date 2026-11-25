"""Emit src/models/related_selections.json: related/inherited Selection fields whose selection is dynamic in
gen/out/<template>/models.json only because they are related (fields.py:690 setup_related copies the target's
`selection`), with the static target field they resolve to. Run: python3 src/models/gen_related_selections.py"""
import json, os
HERE = os.path.dirname(os.path.abspath(__file__))
M = json.load(open(os.path.join(HERE, "..", "..", "gen", "out", "poc_erp", "models.json")))["models"]

def target(model, field, depth=0):
    f = M[model]["fields"].get(field)
    if f is None or depth > 10:
        return None
    if not f.get("selection_dynamic"):
        return (model, field) if f.get("selection") is not None else None
    rel = f.get("related")
    if f.get("inherited") and not rel:
        return None
    if not rel:
        return None
    cur = model
    parts = rel.split(".")
    for p in parts[:-1]:
        pf = M[cur]["fields"].get(p)
        if pf is None or not pf.get("comodel_name"):
            return None
        cur = pf["comodel_name"]
    return target(cur, parts[-1], depth + 1)

out = []
for model, d in sorted(M.items()):
    if d.get("abstract"):
        continue
    for name, f in sorted(d["fields"].items()):
        if f.get("type") in ("selection", "reference") and f.get("selection_dynamic") and f.get("related"):
            t = target(model, name)
            if t is not None:
                out.append([model, name, t[0], t[1]])
json.dump(out, open(os.path.join(HERE, "related_selections.json"), "w"), indent=0)
print(len(out))
