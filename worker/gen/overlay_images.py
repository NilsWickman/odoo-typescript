"""overlay_images.py [--check]: the `image` key of models.json (gen/models.py: max_width, max_height and
verify_resolution of a fields.Image) in the overlays written before the key existed, without an Odoo run per overlay.

An overlay's models.json holds whole model entries of its own registry (template_delta.py). The Image attributes of a
field in that registry are those of the base's registry unless one of the overlay's own modules (its modules minus
the base's, gen/out/templates.json) changes the field. This script copies the base's `image` key into an overlay entry
only when it can show that no such change exists, and refuses the overlay otherwise (it has to be generated again
with compiler/sitebuild.py, which runs gen/models.py on the overlay's own registry):

  - a Python file of an own module (outside tests/) names `Image(`, `max_width`, `max_height` or
    `verify_resolution`, or assigns `<name> = fields.<Class>(` for a field name that is an Image field in the base;
  - the overlay entry has a binary field the base's entry of that model does not have (a new field, or a model that
    is new, can be an Image field through a mixin without any of the text above);
  - the overlay entry's `inherit` differs from the base's and the model has a binary field (a new parent can
    redefine an existing field).

Fields that are not binary carry no `image` key and are left as they are. --check writes nothing and exits 1 when an
overlay would change or is refused. Run after gen/models.py on the base: .venv/bin/python worker/gen/overlay_images.py
"""
import glob
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, 'out')
TRIGGER = re.compile(r'Image\(|max_width|max_height|verify_resolution')
ASSIGN = re.compile(r'^\s*(\w+)\s*=\s*fields\.\w+\(', re.M)


def module_dir(name):
    for d in [os.path.join(ROOT, 'odoo', 'addons', name), os.path.join(ROOT, 'odoo', 'odoo', 'addons', name),
              *glob.glob(os.path.join(ROOT, 'oca', '*', name))]:
        if os.path.isdir(d):
            return d
    return None


def own_module_reasons(modules, image_names):
    reasons = []
    for m in modules:
        d = module_dir(m)
        if d is None:
            reasons.append(f'{m}: no source')
            continue
        for p in sorted(glob.glob(os.path.join(d, '**', '*.py'), recursive=True)):
            if f'{os.sep}tests{os.sep}' in p:
                continue
            with open(p, encoding='utf-8', errors='replace') as f:
                s = f.read()
            where = os.path.relpath(p, ROOT)
            for mm in TRIGGER.finditer(s):
                reasons.append(f'{where}:{s[:mm.start()].count(chr(10)) + 1} {mm.group(0)}')
            for mm in ASSIGN.finditer(s):
                if mm.group(1) in image_names:
                    reasons.append(f'{where}:{s[:mm.start()].count(chr(10)) + 1} redefines {mm.group(1)}')
    return reasons


def load(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def main():
    check = '--check' in sys.argv[1:]
    sys.path.insert(0, HERE)
    with open(os.path.join(OUT, 'templates.json'), encoding='utf-8') as f:
        templates = json.load(f)
    status = 0
    for name, info in sorted(templates.items()):
        overlay = info.get('overlay')
        if not overlay:
            continue
        path = os.path.join(OUT, overlay, 'models.json')
        if not os.path.exists(path):
            continue
        base_name = info['dir']
        base = load(os.path.join(OUT, base_name, 'models.json'))['models']
        data = load(path)
        image_names = {fn for m in base.values() for fn, fi in m['fields'].items() if 'image' in fi}
        own = sorted(set(info['modules']) - set(templates[base_name]['modules']))
        reasons = own_module_reasons(own, image_names)
        changed = 0
        out = {}
        for mn, entry in data['models'].items():
            b = base.get(mn)
            binary = [fn for fn, fi in entry['fields'].items() if fi['type'] == 'binary']
            if binary and b is None:
                reasons.append(f'{mn}: a model the base does not have, with binary fields')
            elif binary and entry.get('inherit') != b.get('inherit'):
                reasons.append(f'{mn}: its parents differ from the base\'s, with binary fields')
            fields = {}
            for fn, fi in entry['fields'].items():
                fi = dict(fi)
                if fi['type'] == 'binary':
                    bf = (b or {}).get('fields', {}).get(fn)
                    if bf is None:
                        reasons.append(f'{mn}.{fn}: a binary field the base does not have')
                    elif 'image' in bf and fi.get('image') != bf['image']:
                        fi['image'] = bf['image']
                        changed += 1
                    elif 'image' not in bf and 'image' in fi:
                        reasons.append(f'{mn}.{fn}: an Image field in the overlay, not in the base')
                fields[fn] = fi
            out[mn] = {**entry, 'fields': fields}
        # an overlay generated with the key (gen/models.py ran on its registry) is its own source: nothing to copy
        if reasons and any('image' in fi for m in data['models'].values() for fi in m['fields'].values()) and not changed:
            print(f'{overlay}: generated with the image key, left as it is')
            continue
        if reasons:
            status = 1
            print(f'{overlay}: REFUSED, generate it again (compiler/sitebuild.py): ' + '; '.join(reasons[:6])
                  + (f' (+{len(reasons) - 6})' if len(reasons) > 6 else ''))
            continue
        if not changed:
            print(f'{overlay}: nothing to copy')
            continue
        print(f'{overlay}: {changed} image fields from {base_name}' + (' (check: would change)' if check else ''))
        if check:
            status = 1
            continue
        import _odoo  # write_json: the text template_delta.py writes an overlay's models.json with
        _odoo.write_json(path, {**data, 'models': out})
    sys.exit(status)


if __name__ == '__main__':
    main()
