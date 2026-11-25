"""Field defaults (`default=`) of every stored or cached field, for the write path's default_get
(odoo/odoo/orm/models.py:1317). Run: GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/write_defaults.py
(and without GEN_TEMPLATE for poc_corpus). Output: gen/out[/<template>]/write_defaults.json:

  {model: {field: {"const": value}                       non-callable defaults (fields.py:545-547 wraps them)
                 | {"expr": "<normalised lambda body>", "src": "file:line"}   lambdas, matched by the port per pattern
                 | {"callable": "module.qualname", "src": "file:line"}}}      methods: hand-ported or refused

The port never evaluates a callable it does not know: an unknown pattern refuses (NotPorted) only when that
field's default is requested.
"""
import inspect
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(__file__))
import _odoo  # noqa: E402


def jsonable(v):
    try:
        json.dumps(v)
        return True
    except TypeError:
        return False


def describe(field):
    d = field.default
    if d is None:
        return None
    code = getattr(d, '__code__', None)
    # fields.py:545-547: `self.default = lambda model: value` for non-callable values
    if code is not None and code.co_filename.endswith(os.path.join('orm', 'fields.py')) and d.__closure__:
        value = d.__closure__[0].cell_contents
        if jsonable(value):
            return {'const': value}
        return {'callable': repr(value)[:80], 'src': 'fields.py:547'}
    try:
        src_file = inspect.getsourcefile(d)
        line = inspect.getsourcelines(d)[1]
        rel = _odoo.rel(src_file)
        where = f'{rel}:{line}'
    except (TypeError, OSError):
        where = None
    if getattr(d, '__name__', '') == '<lambda>':
        try:
            text = inspect.getsource(d)
        except OSError:
            return {'callable': '<lambda>', 'src': where}
        m = re.search(r'lambda\s+(\w+)\s*:\s*(.*)', text, re.S)
        if m:
            body = m.group(2)
            # cut the lambda body at the end of the expression: balanced brackets, stop at a top-level comma/paren
            depth, out = 0, []
            for ch in body:
                if ch in '([{':
                    depth += 1
                elif ch in ')]}':
                    if depth == 0:
                        break
                    depth -= 1
                elif ch == ',' and depth == 0:
                    break
                elif ch == '\n' and depth == 0:
                    break
                out.append(ch)
            expr = re.sub(r'\s+', ' ', ''.join(out)).strip().replace(m.group(1) + '.', 'self.')
            return {'expr': expr, 'src': where}
        return {'callable': '<lambda>', 'src': where}
    qual = f"{getattr(d, '__module__', '?')}.{getattr(d, '__qualname__', getattr(d, '__name__', '?'))}"
    return {'callable': qual, 'src': where}


def main():
    with _odoo.env() as env:
        out = {}
        for name in sorted(env.registry.models):
            model = env[name]
            fields = {}
            for fname, field in sorted(model._fields.items()):
                desc = describe(field)
                if desc is not None:
                    fields[fname] = desc
            out[name] = fields
    path = os.path.join(_odoo.OUT, 'write_defaults.json')
    with open(path, 'w') as f:
        json.dump(out, f, indent=0, sort_keys=True, ensure_ascii=False)
        f.write('\n')
    print(path, sum(len(v) for v in out.values()), 'defaults')


if __name__ == '__main__':
    main()
