"""write_overrides.py -> gen/out/<template>/write_overrides.json: the Python overrides of `create`, `write` and `unlink`
(and the `@api.ondelete` methods) of every model of the registry, so that the Worker's generic ORM (src/orm/write.ts,
create.ts, unlink.ts) refuses a model whose override has no port instead of skipping its side effects
(src/orm/override_guard.ts; rådet runda 12, åtgärd 1).

`models`: for each model and each method, the classes in the registry class's MRO above BaseModel that define the
method (odoo/odoo/orm/models.py `create` :4216, `write` :3805, `unlink` :3658 are the base), in MRO order (the first
one runs first and reaches the next through `super()`), as `"<python module>:<qualname>"`; `ondelete`: the
`@api.ondelete` methods (`_ondelete_methods`; BaseModel.unlink runs them before the delete, models.py:3670-3672) as
`"<class>.<method>"`. `classes`: per class and method the source line and the `keys` hint, and per `@api.ondelete`
method its source and `at_uninstall`.

`keys` is a hint for the reader, not a decision: the string constants of the model's field names that the override's
body tests or reads on its values argument (`'f' in vals`, `vals.get('f')`, `vals['f']`, `vals.pop('f')`, and names in
a literal list/set/tuple the body compares with the values). The port's table (src/orm/override_guard.ts) decides per
override, after reading its source, whether it is ported, acts only for some keys, or refuses.

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/write_overrides.py
"""
import ast
import inspect
import os
import sys
import textwrap

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

METHODS = ('create', 'write', 'unlink')


def where(func):
    func = inspect.unwrap(func)
    try:
        path = inspect.getsourcefile(func)
        line = inspect.getsourcelines(func)[1]
    except (OSError, TypeError):
        return None, None
    return f'{os.path.relpath(path, os.path.join(_odoo.ROOT, "odoo"))}:{line}', func


def vals_keys(func, fields):
    """String constants naming a field of the model that the body uses next to its values argument."""
    try:
        tree = ast.parse(textwrap.dedent(inspect.getsource(func)))
    except (OSError, TypeError, SyntaxError):
        return None
    fn = tree.body[0]
    if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
        return None
    params = [a.arg for a in fn.args.args[1:]]
    if not params:
        return []
    aliases = {params[0]}
    # `for vals in vals_list` (create) and simple renames `values = vals`
    for node in ast.walk(fn):
        if isinstance(node, ast.For) and isinstance(node.iter, ast.Name) and node.iter.id in aliases and isinstance(node.target, ast.Name):
            aliases.add(node.target.id)
        if isinstance(node, ast.Assign) and isinstance(node.value, ast.Name) and node.value.id in aliases:
            for t in node.targets:
                if isinstance(t, ast.Name):
                    aliases.add(t.id)

    def is_alias(node):
        if isinstance(node, ast.Name) and node.id in aliases:
            return True
        # vals.keys(), set(vals), dict(vals)
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Attribute) and node.func.attr == 'keys' and is_alias(node.func.value):
                return True
            if isinstance(node.func, ast.Name) and node.func.id in ('set', 'dict', 'frozenset') and node.args and is_alias(node.args[0]):
                return True
        return False

    def consts(node):
        out = set()
        for n in ast.walk(node):
            if isinstance(n, ast.Constant) and isinstance(n.value, str):
                out.add(n.value)
        return out

    keys = set()
    for node in ast.walk(fn):
        if isinstance(node, ast.Compare):
            sides = [node.left, *node.comparators]
            if any(is_alias(s) for s in sides) or any(isinstance(op, (ast.In, ast.NotIn)) and is_alias(c) for op, c in zip(node.ops, node.comparators)):
                for s in sides:
                    if not is_alias(s):
                        keys |= consts(s)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and is_alias(node.func.value) \
                and node.func.attr in ('get', 'pop', 'setdefault') and node.args:
            keys |= consts(node.args[0])
        elif isinstance(node, ast.Subscript) and is_alias(node.value):
            keys |= consts(node.slice)
        elif isinstance(node, ast.BinOp) and isinstance(node.op, (ast.BitAnd, ast.Sub, ast.BitOr)) and (is_alias(node.left) or is_alias(node.right)):
            keys |= consts(node.left) | consts(node.right)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr in ('intersection', 'isdisjoint', 'issubset', 'issuperset') \
                and (is_alias(node.func.value) or any(is_alias(a) for a in node.args)):
            for a in [node.func.value, *node.args]:
                keys |= consts(a)
    # module-level constants used as key lists (e.g. `fields & SOME_FIELDS`) are not resolved: the hint stays partial
    return sorted(k for k in keys if k in fields)


def main():
    from odoo.orm.models import BaseModel
    models, classes = {}, {}
    with _odoo.env() as env:
        for name in sorted(env.registry.models):
            model = env[name]
            cls = type(model)
            entry = {}
            for meth in METHODS:
                chain = []
                for klass in cls.__mro__:
                    if klass is BaseModel:
                        break
                    if meth in vars(klass):
                        key = f'{klass.__module__}:{klass.__qualname__}'
                        chain.append(key)
                        info = classes.setdefault(key, {}).setdefault(meth, None)
                        src, func = where(vars(klass)[meth])
                        keys = set(vals_keys(func, model._fields) or []) if func is not None and meth != 'unlink' else set()
                        if info is None:
                            classes[key][meth] = info = {'src': src}
                            if meth != 'unlink':
                                info['keys'] = []
                        if meth != 'unlink':
                            info['keys'] = sorted(set(info['keys']) | keys)
                if chain:
                    entry[meth] = chain
            ondel = []
            for func in model._ondelete_methods:
                src, f = where(func)
                owner = next((k for k in cls.__mro__ if func.__name__ in vars(k)
                              and inspect.unwrap(vars(k)[func.__name__]) is inspect.unwrap(func)), None)
                key = f'{owner.__module__}:{owner.__qualname__}' if owner else '?'
                ondel.append(f'{key}.{func.__name__}')
                classes.setdefault(key, {}).setdefault('ondelete', {})[func.__name__] = {
                    'src': src, 'at_uninstall': bool(getattr(func, '_ondelete', False))}
            if ondel:
                entry['ondelete'] = sorted(ondel)
            if entry:
                models[name] = entry
    path = _odoo.write_json(os.path.join(_odoo.OUT, 'write_overrides.json'),
                            {'_source': 'worker/gen/write_overrides.py', 'odoo_commit': 'dd5d371863dd96f640e4a4b970d8437bb9861cba',
                             'classes': classes, 'models': models})
    counts = {m: sum(1 for e in models.values() if m in e) for m in (*METHODS, 'ondelete')}
    distinct = {m: sum(1 for c in classes.values() if m in c) for m in (*METHODS, 'ondelete')}
    print(path, len(models), 'models', counts, 'classes per method', distinct)


if __name__ == '__main__':
    main()
