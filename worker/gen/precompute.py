"""precompute.py -> gen/out[/<template>]/precompute.json: the `precompute=True` fields of every model.

Run: .venv/bin/python worker/gen/precompute.py              (poc_corpus, scratch copy dev_gen)
     GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/precompute.py   (poc_erp, scratch copy dev_gen_poc_erp)

Source (Odoo 20, commit dd5d3718): odoo/odoo/orm/models.py:4302-4345 `_add_precomputed_values`:
  fields      the names of `self._fields` with `field.precompute`, in `_fields` order (the order Odoo computes
              them in, :4337)
  sudo        the subset with `field.compute_sudo` (:4341 `record.sudo()[fname]`)
  groups      `pool.field_computed[field]` for every precompute field computed together with others (:4316-4319:
              setting one of them leaves the others False instead of computing them)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402


def main():
    out = {}
    with _odoo.env() as env:
        for name in sorted(env.registry.models):
            model = env[name]
            pre = [f for f, field in model._fields.items() if field.precompute]
            if not pre:
                continue
            groups = []
            for f in pre:
                together = [g.name for g in env.registry.field_computed.get(model._fields[f], [])]
                if len(together) > 1 and together not in groups:
                    groups.append(together)
            out[name] = {
                'fields': pre,
                'sudo': [f for f in pre if model._fields[f].compute_sudo],
                'groups': groups,
            }
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'precompute.json'), {'odoo_commit': 'dd5d371863dd96f640e4a4b970d8437bb9861cba', 'db': _odoo.DB, 'models': out})
    print(path, len(out), 'models', sum(len(v['fields']) for v in out.values()), 'fields')


if __name__ == '__main__':
    main()
