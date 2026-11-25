"""Which method each field's `group_expand` names (fields.py:1109 `group_expand`, :1144-1160 `determine_group_expand`),
for the port's read_group (src/web/read_group.ts). models.json only says whether a field has one; the method decides
what the empty groups are. Two are generic and the port applies them to any field without a hand-ported one:
  "full"       models.py:2375 `_read_group_expand_full`: every record of the comodel
  "selection"  a selection field's `group_expand=True`, fields_selection.py:214-216 `_default_group_expand`
Any other method is written by its name (a model's own `_read_group_stage_ids` and the like), which the port must
register by hand (registerGroupExpand) or it does not expand the field.

Writes out/<template>/group_expand.json: {model: {field: "full" | "selection" | "<method name>"}}.

  GEN_TEMPLATE=poc_erp GEN_DB=<a copy of poc_erp> ../.venv/bin/python gen/group_expand.py
"""
import json
import os
import _odoo

with _odoo.env() as env:
    out = {}
    for model in sorted(env.registry.models):
        for name, field in sorted(env[model]._fields.items()):
            ge = field.group_expand
            if not ge:
                continue
            if ge is True:
                kind = 'selection' if field.type == 'selection' else 'True'
            elif isinstance(ge, str):
                kind = 'full' if ge == '_read_group_expand_full' else ge
            else:
                fn = getattr(ge, '__name__', repr(ge))
                kind = 'full' if fn == '_read_group_expand_full' else fn
            out.setdefault(model, {})[name] = kind
    os.makedirs(_odoo.OUT, exist_ok=True)
    path = os.path.join(_odoo.OUT, 'group_expand.json')
    with open(path, 'w') as f:
        json.dump(out, f, indent=1, sort_keys=True)
        f.write('\n')
    print(f"{path}: {sum(len(v) for v in out.values())} fields on {len(out)} models")
