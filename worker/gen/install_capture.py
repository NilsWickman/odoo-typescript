"""install_capture.py <overlay> <module ...>: Odoo's own install of <module ...> on GEN_DB (a fresh copy of the
overlay's base template), with every statement it executes recorded, cut into the phases of
odoo/modules/loading.py, and the schema and reflection part kept for src/modules/install.ts to replay at the same
points: gen/out/<overlay>/install_capture.json.

The install is `button_immediate_install`'s (ir_module.py:608-665): `button_install` in a committed transaction, then
`Registry.new(db, update_module=True)` (load_modules), run here in-process. Phases, from hooks on loading.py and the
registry:

    init:<module>   from `registry.init_models` of the module (its tables, columns, `_auto_init`'s column values and
                    indexes, the reflection of models, fields, selections, constraints, inherits and relations with
                    their xmlids) up to its first data file
    data:<module> / demo:<module>   the module's files (kept: only schema and ir_model* writes, none expected)
    post:<module>   after its demo (`_reflect_field_groups`, its state; kept: schema and ir_model*)
    translations:<module>   `_update_translations` of the installed languages (kept: every write; the records it
                    updates have the ids the port's install gives them, Odoo's)
    end             after the last module (finalized constraints, `init_models` of the models to check: kept: schema
                    and ir_model*)

What is kept of a phase is replayed verbatim, so the ids and the sequences are Odoo's: every statement as executed
(parameters inlined by psycopg2's mogrify), the transaction's `now()` given as a parameter replaced by a marker the
replay turns into `now() AT TIME ZONE 'UTC'`. The replay checks a fingerprint of the registry tables and their
sequences first (FINGERPRINT_SQL, kept identical in install.ts): the captured literals (ids, sequence values) only
hold on that state.

Run (GEN_DB a fresh copy of the base, e.g. `harness/dbs.py create dev_gen_poc_erp_maint poc_erp`):
    GEN_TEMPLATE=<overlay> GEN_DB=<copy> .venv/bin/python worker/gen/install_capture.py <overlay> <module ...>

`--uninstall <module>` (GEN_TEMPLATE the template with the module): the module installed by Odoo first if it is not,
then `button_immediate_uninstall` captured the same way: what the loads around the uninstall write that the port does not
do itself (the reflection of `models_to_check`), to gen/out/<template>/uninstall/<module>.json.

`--upgrade <module>` captures `button_immediate_upgrade` of an installed module of the template GEN_TEMPLATE names
(B3, what `-u` does) the same way, on a fresh copy of that template: the phases are the same (init: its models'
reflection again, data/demo: its files in update mode, post, translations, end). The data files are not replayed
(what the load writes depends on the records as the user left them: noupdate, values already equal), the port loads
them in update mode (src/modules/convert.ts); they are written with the capture, with the manifest, to
gen/out/<template>/upgrade/<module>.json (src/modules/upgrade.ts):
    GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/install_capture.py --upgrade crm_iap_enrich
"""
import contextlib
import dis
import types
import datetime
import hashlib
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

UPGRADE = sys.argv[1] == '--upgrade'
UNINSTALL = sys.argv[1] == '--uninstall'
OVERLAY, MODULES = (None, sys.argv[2:]) if UPGRADE or UNINSTALL else (sys.argv[1], sys.argv[2:])
REFLECT = ('ir_model', 'ir_model_fields', 'ir_model_fields_selection', 'ir_model_constraint', 'ir_model_relation',
           'ir_model_inherit', 'ir_model_fields_group_rel')
NOW = '@@capture-now@@'  # replaced by the replay (the capture's `now`, src/modules/install.ts replayPhase)

# the registry's tables and sequences the captured statements depend on (kept identical in src/modules/install.ts)
FINGERPRINT_SQL = """
SELECT md5(string_agg(t.v, E'\\n' ORDER BY t.k)) FROM (
  SELECT 'seq ' || s.sequencename AS k, s.sequencename || '=' || COALESCE(s.last_value::text, '-') AS v
    FROM pg_sequences s WHERE s.schemaname = 'public' AND s.sequencename IN ('ir_model_id_seq', 'ir_model_fields_id_seq',
         'ir_model_fields_selection_id_seq', 'ir_model_constraint_id_seq', 'ir_model_relation_id_seq',
         'ir_model_inherit_id_seq', 'ir_model_data_id_seq')
  UNION ALL SELECT 'n ir_model', count(*)::text FROM ir_model
  UNION ALL SELECT 'n ir_model_fields', count(*)::text FROM ir_model_fields
  UNION ALL SELECT 'n ir_model_fields_selection', count(*)::text FROM ir_model_fields_selection
  UNION ALL SELECT 'n ir_model_constraint', count(*)::text FROM ir_model_constraint
  UNION ALL SELECT 'n ir_model_relation', count(*)::text FROM ir_model_relation
  UNION ALL SELECT 'n ir_model_inherit', count(*)::text FROM ir_model_inherit
  UNION ALL SELECT 'n ir_model_data', count(*)::text FROM ir_model_data
  UNION ALL SELECT 'tables', string_agg(tablename, ',' ORDER BY tablename) FROM pg_tables WHERE schemaname = 'public'
) t
"""

WRITE = re.compile(r'^\s*(INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE|ALTER|COMMENT\s+ON|DROP|WITH)\b', re.I)
TARGET = re.compile(r'^\s*(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"?([a-z_0-9]+)"?', re.I)
DDL = re.compile(r'^\s*(CREATE|ALTER|COMMENT\s+ON|DROP)\b', re.I)


def keep(phase, sql):
    if not WRITE.match(sql):
        return False
    if re.match(r'^\s*CREATE\s+SEQUENCE\s+"?ir_sequence_\d+', sql, re.I) or re.match(r'^\s*(ALTER|DROP)\s+SEQUENCE\s+"?ir_sequence_\d+', sql, re.I):
        return False  # ir.sequence records of the data files (the port creates them)
    m = TARGET.match(sql)
    table = m.group(1).lower() if m else None
    if table in ('ir_module_module', 'ir_module_module_dependency', 'ir_module_category', 'ir_module_module_exclusion',
                 'orm_signaling_registry', 'orm_signaling_default', 'orm_signaling_stable', 'orm_signaling_groups',
                 'orm_signaling_assets', 'orm_signaling_templates', 'orm_signaling_routing', 'ir_cron_trigger', 'ir_cron'):
        return False  # module states, update_list, signaling and the autovacuum: install.ts does them
    if phase.startswith('init:') or phase.startswith('translations:'):
        return True  # the schema work of init_models; what the translation import writes (loading.py:230-232)
    if DDL.match(sql):
        return True
    if table in REFLECT:
        return True
    if table == 'ir_model_data':
        return bool(re.search(r"'ir\.model(\.fields|\.fields\.selection|\.constraint|\.relation|\.inherit)?'", sql))
    return False


# D23 path B, B1: with the reflection written by the port (src/modules/reflect.ts), what the replayed statements depend
# on is narrower than the registry tables of FINGERPRINT_SQL. `replay_check` names it, item by item, with the values the
# capture's database had before the install: the tables of the DDL statements (whether each exists), and for every
# table whose ids the kept statements carry as literals (`_init_column`'s update of existing rows), its id sequence and
# its row count. The translation import is not replayed (B2: data['translations'], whose term translations check each
# record's value at runtime), so the ids the data files give are not in it. The reflection tables and ir_model_data are not
# in it: no kept statement carries their ids. src/modules/install.ts runs `sql` and refuses unless it returns `expected`.
NOT_IDS = set(REFLECT) | {'ir_model_data', 'ir_model_relation'}
DDL_TABLE = re.compile(r'^\s*(?:CREATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?"?([a-z_0-9]+)"?', re.I)
LITERAL_IDS = re.compile(r'\b(?:VALUES\s*\(\s*\d+\s*,|id\s*(?:=|IN)\s*\(?\s*\d+)', re.I)


FLUSH_SET = re.compile(r'"([a-z_0-9]+)"\s*=\s*"__tmp"\."([a-z_0-9]+)"')


def init_flush(sql, columns):
    """Whether `sql` is the flush of values computed by `_init_column_data` (`env.add_to_compute`, flushed by
    `_write_multi` as `UPDATE "<table>" SET "<f>" = "__tmp"."<f>"::..., "write_date" = ..., "write_uid" = ... FROM
    (VALUES ...)`): only the computed new columns of that table and the log columns."""
    m = TARGET.match(sql)
    if not m or not sql.lstrip().upper().startswith('UPDATE') or '"__tmp"' not in sql:
        return False
    computed = {c['field'] for c in columns if c['compute'] and c['table'] == m.group(1)}
    cols = {a for a, _b in FLUSH_SET.findall(sql)}
    return bool(cols & computed) and cols <= computed | {'write_date', 'write_uid', 'id'}  # id: the WHERE's join


def snapshot(cr):
    cr.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")
    tables = {r[0] for r in cr.fetchall()}
    cr.execute(r"""SELECT c.relname, (regexp_match(pg_get_expr(d.adbin, d.adrelid), 'nextval\(''"?([a-z_0-9]+)"?''::regclass'))[1]
                    FROM pg_attrdef d JOIN pg_class c ON c.oid = d.adrelid
                    JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
                   WHERE a.attname = 'id' AND c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'""")
    seq_of = {t: s for t, s in cr.fetchall() if s}
    cr.execute("SELECT sequencename, COALESCE(last_value::text, '-') FROM pg_sequences WHERE schemaname = 'public'")
    seqs = dict(cr.fetchall())
    counts = {}
    for t in sorted(tables):
        cr.execute(f'SELECT count(*) FROM "{t}"')
        counts[t] = cr.fetchone()[0]
    return {'tables': tables, 'seq_of': seq_of, 'seqs': seqs, 'counts': counts}


def check_of(pre, phases, log):
    ddl, ids = set(), set()
    for stmts in phases.values():
        for sql in stmts:
            m = DDL_TABLE.match(sql)
            if m:
                ddl.add(m.group(1))
                continue
            m = TARGET.match(sql)
            if m and m.group(1) not in NOT_IDS and LITERAL_IDS.search(sql):
                ids.add(m.group(1))
    items = []
    for t in sorted(ddl):
        items.append((f'exists {t}', f"(to_regclass('public.\"{t}\"') IS NOT NULL)::text", 'true' if t in pre['tables'] else 'false'))
    for t in sorted(ids & pre['tables']):
        items.append((f'count {t}', f'(SELECT count(*) FROM "{t}")::text', str(pre['counts'][t])))
        s = pre['seq_of'].get(t)
        if s:
            items.append((f'seq {s}', f"COALESCE((SELECT last_value::text FROM pg_sequences WHERE schemaname = 'public' AND sequencename = '{s}'), '-')",
                          pre['seqs'].get(s, '-')))
    items = sorted({k: (k, e, v) for k, e, v in items}.values())
    sql = '\nUNION ALL '.join(f"SELECT '{k}' AS k, {e} AS v" for k, e, _v in items) + '\nORDER BY k'
    return {'sql': sql, 'expected': [[k, v] for k, _e, v in items]}


# VAGB B0, the registry per module: the generators compiler/sitebuild.py runs on the final registry, run here in-process
# on the registry of each step (src/orm/overlay.ts applies a step's entries while that module's data loads). Each
# file with the map holding its per-model entries (as template_delta.py FILES; settings_fields.json is one whole entry
# per top-level key). field_order.json is gen_field_order.py's one line, inline: that script writes into src/models/.
STEP_GENERATORS = ['models', 'check_company', 'onchange_methods', 'precompute', 'public_methods', 'write_defaults',
                   'button_names', 'settings_fields', 'copy_overrides']
STEP_FILES = {'models.json': 'models', 'precompute.json': 'models', 'check_company.json': 'models',
              'public_methods.json': 'models', 'write_defaults.json': None, 'field_order.json': None,
              'button_names.json': 'models', 'copy_overrides.json': 'models', 'onchange_methods.json': 'models',
              'settings_fields.json': None}
# not stepped: table_sql.json (a SQL view of a new module refuses in template_delta.py) and controller_overrides.json
# (read from the source, not the registry); the overlay must have no entry in them (checked in steps_of)
UNSTEPPED = ['table_sql.json', 'controller_overrides.json']


def step_outputs(env, phase_name):
    """The generators' outputs on `env`'s registry, read back from a scratch GEN_OUT (they write files)."""
    import runpy
    import tempfile
    import odoo
    here = os.path.dirname(os.path.abspath(__file__))
    before = STATE['phase']
    STATE['phase'] = phase_name
    n_log = len(STATE['log'])
    env.flush_all()
    real_env, real_out = _odoo.env, _odoo.OUT

    @contextlib.contextmanager
    def step_env(db=None, commit=False):
        assert not commit, 'a generator committed during the capture'
        yield odoo.api.Environment(env.cr, odoo.api.SUPERUSER_ID, env['res.users'].context_get())
    out = {}
    try:
        with tempfile.TemporaryDirectory() as tmp:
            _odoo.env, _odoo.OUT = step_env, tmp
            argv = sys.argv
            for g in STEP_GENERATORS:
                sys.argv = [os.path.join(here, f'{g}.py')]
                runpy.run_path(os.path.join(here, f'{g}.py'), run_name='__main__')
            sys.argv = argv
            for name in STEP_FILES:
                if name == 'field_order.json':
                    continue
                with open(os.path.join(tmp, name), encoding='utf-8') as f:
                    out[name] = json.load(f)
        with step_env() as e:
            # src/models/gen_field_order.py: per model, `_fields` order
            out['field_order.json'] = {n: list(e[n]._fields) for n in sorted(e.registry.models)}
    finally:
        _odoo.env, _odoo.OUT = real_env, real_out
        STATE['phase'] = before
    writes = [t for p, t, _r in STATE['log'][n_log:] if p == phase_name]
    if writes:
        raise SystemExit(f'install_capture: the generators wrote during {phase_name}: {writes[0][:200]}')
    # the generators' reads leave values in the cache; the load goes on from the database as without them
    env.invalidate_all()
    return out


def steps_of(steps, final, modules, overlay_dir):
    """Per step, the entries of the models the installed modules touch (final models.json `modules`, as
    template_delta.py --models-of) that differ from the final registry's: the step's value, or None where the step has
    no such entry. Paths normalized as template_delta.py writes them."""
    from template_delta import normalized
    for name in UNSTEPPED:
        p = os.path.join(overlay_dir, name)
        if os.path.exists(p):
            with open(p, encoding='utf-8') as f:
                data = json.load(f)
            if any(k not in ('db', 'odoo_commit') and v for k, v in data.items()):
                raise SystemExit(f'install_capture: {name} of the overlay has entries: the registry per module does not step it')
    mods = set(modules)
    only = {m for m, d in final['models.json']['models'].items() if set(d.get('modules') or ()) & mods}
    out = {}
    for module, files in steps.items():
        patch = {}
        for name, key in STEP_FILES.items():
            s, f = files[name], final[name]
            if name == 'settings_fields.json':
                d = {k: normalized(v) for k, v in s.items() if v != f.get(k)}
            elif key is None:
                d = {m: normalized(s.get(m)) if m in s else None for m in sorted(only) if s.get(m) != f.get(m)}
            else:
                if name in ('public_methods.json', 'button_names.json') and s.get('common') != f.get('common'):
                    raise SystemExit(f'install_capture: {name}: the common names differ at {module}')
                d = {key: {m: normalized(s[key].get(m)) if m in s[key] else None for m in sorted(only) if s[key].get(m) != f[key].get(m)}}
                if not d[key]:
                    d = {}
            if d:
                patch[name] = d
        out[module] = patch
    return out


STATE = {}


def main():
    _odoo.boot()
    import odoo
    import odoo.sql_db
    import odoo.modules.loading as loading
    from odoo.modules.registry import Registry

    state = STATE
    state.update(phase='button', log=[])

    real_execute = odoo.sql_db.Cursor.execute

    def execute(self, query, params=None, log_exceptions=True):
        res = real_execute(self, query, params, log_exceptions)
        from odoo.tools.sql import SQL
        if isinstance(query, SQL):
            sql, args, _fields = query._sql_tuple
        elif hasattr(query, 'as_string'):
            sql, args = query.as_string(self._obj), params
        else:
            sql, args = query, params
        if isinstance(sql, str) and WRITE.match(sql):
            now = getattr(self, '_now', None)
            if args:
                # the transaction's now() wherever it is, also inside the tuples of a VALUES list (the flush's
                # `UPDATE ... FROM (VALUES (id, value, write_date, write_uid), ...)`)
                def marked(v):
                    if isinstance(v, datetime.datetime) and v == now:
                        return NOW
                    if isinstance(v, tuple):
                        return tuple(marked(x) for x in v)
                    if isinstance(v, list):
                        return [marked(x) for x in v]
                    return v
                if isinstance(args, dict):
                    args = {k: marked(v) for k, v in args.items()}
                else:
                    args = [marked(v) for v in args]
                text = self._obj.mogrify(sql, args).decode()
            else:
                text = sql
            state['log'].append((state['phase'], text, self._obj.rowcount))
        return res
    odoo.sql_db.Cursor.execute = execute

    real_init_models = Registry.init_models

    def init_models(self, cr, model_names, context, install=True):
        module = (context or {}).get('module')
        state['phase'] = f'init:{module}' if module else 'end'
        return real_init_models(self, cr, model_names, context, install)
    Registry.init_models = init_models

    from odoo.addons.base.models.ir_module import IrModuleModule
    real_update_translations = IrModuleModule._update_translations

    def update_translations(self, filter_lang=None, overwrite=False):
        before = state['phase']
        self.env.flush_all()  # the pending writes of the module's data stay in their own phase
        state['phase'] = f"translations:{','.join(self.mapped('name'))}"
        try:
            res = real_update_translations(self, filter_lang, overwrite)
            self.env.flush_all()
            return res
        finally:
            state['phase'] = before
    IrModuleModule._update_translations = update_translations

    # D23 path B, B1 (compiler/VAGB.md): the reflection is not replayed from the statements but written by the port
    # (src/modules/reflect.ts) from what the registry expects at that step, without ids. Each reflection call leaves a
    # placeholder `@@reflect <n>@@` in its phase and its expected rows in data['reflect'][n]; the statements it ran are
    # kept apart (data['reflect_sql'][n]) as reference.
    from odoo.addons.base.models import ir_model as irm
    from odoo import models as orm_models
    from odoo import fields as odoo_fields
    state['reflect'] = []

    def translated(model):
        return sorted(f for f, fld in model._fields.items() if fld.translate is True)

    def rec_models(self, model_names):
        module = self.env.context.get('module')
        return {'module': module, 'names': list(model_names), 'translated': translated(self),
                'rows': [self._reflect_model_params(self.env[m]) for m in model_names],
                'xmlids': [m for m in model_names if module and self.env[m]._module == module]}

    def rec_fields(self, model_names):
        module = self.env.context.get('module')
        rows, xmlids = [], []
        for model_name in model_names:
            model = self.env[model_name]
            for field in model._fields.values():
                rows.append({**self._reflect_field_params(field, None), 'model_id': None})
                if module and (module == model._original_module or module in field._modules or any(
                        field.name in self.env[parent]._fields
                        for parent, parent_module in model._inherit_module.items() if module == parent_module)):
                    xmlids.append([model_name, field.name])
        return {'module': module, 'names': list(model_names), 'translated': translated(self), 'rows': rows, 'xmlids': xmlids}

    def rec_selections(self, model_names):
        module = self.env.context.get('module')
        flds = [field for model_name in model_names for field in self.env[model_name]._fields.values()
                if field.type in ('selection', 'reference') and isinstance(field.selection, tuple)]
        return {'module': module, 'names': list(model_names),
                'fields': [[f.model_name, f.name, [list(vl) for vl in f.selection]] for f in flds],
                'xmlids': [[f.model_name, f.name, value, m] for f in flds
                           for value, modules in f._selection_modules(self.env[f.model_name]).items() for m in modules]
                if module else []}

    def rec_constraints(self, model_names):
        rows = []
        for model_name in model_names:
            model = self.env[model_name]
            for conname, cons in model._table_objects.items():
                if not conname or not cons._module:
                    continue
                message = cons.message if isinstance(cons.message, str) and cons.message else None
                rows.append([model_name, conname, 'i' if isinstance(cons, orm_models.Index) else 'u',
                             cons.get_definition(model.pool), cons._module, message])
        return {'names': list(model_names), 'rows': rows}

    def rec_inherits(self, model_names):
        mapping = {}
        for model_name in model_names:
            model = self.env[model_name]
            for cls in reversed(type(model).mro()):
                if not orm_models.is_model_definition(cls):
                    continue
                items = [(model_name, p, None) for p in cls._inherit if p not in ('base', model_name)] + \
                    [(model_name, p, f) for p, f in cls._inherits.items()]
                for item in items:
                    mapping.setdefault(item, [])
                    if cls._module not in mapping[item]:
                        mapping[item].append(cls._module)
        return {'names': list(model_names), 'rows': [[*k, v] for k, v in mapping.items()]}

    def rec_field_groups(self, model_names):
        expected = []
        for model_name in model_names:
            for field in self.env[model_name]._fields.values():
                if not field.groups or field.groups == odoo_fields.NO_ACCESS:
                    continue
                expected += [[model_name, field.name, x] for x in field.groups.split(',') if x[0] != '!']
        return {'names': list(model_names), 'rows': expected}

    def reflecting(cls, name, kind, record):
        real = getattr(cls, name)

        def wrapper(self, model_names, *args, **kwargs):
            if state['phase'] in ('button', 'load'):
                return real(self, model_names, *args, **kwargs)
            before = state['phase']
            n = len(state['reflect'])
            state['reflect'].append({'kind': kind, **record(self, model_names)})
            state['log'].append((before, f'@@reflect {n}@@', 0))
            state['phase'] = f'reflect {n}'
            try:
                return real(self, model_names, *args, **kwargs)
            finally:
                state['phase'] = before
        setattr(cls, name, wrapper)
    reflecting(irm.IrModel, '_reflect_models', 'models', rec_models)
    reflecting(irm.IrModelFields, '_reflect_fields', 'fields', rec_fields)
    reflecting(irm.IrModelFieldsSelection, '_reflect_selections', 'selections', rec_selections)
    reflecting(irm.IrModelConstraint, '_reflect_constraints', 'constraints', rec_constraints)
    reflecting(irm.IrModelInherit, '_reflect_inherits', 'inherits', rec_inherits)
    reflecting(irm.IrModelFields, '_reflect_field_groups', 'field_groups', rec_field_groups)

    # `_reflect_constraint` from `check_foreign_keys` (a foreign key's row, ir_model.py:2156-2200) and `_reflect_relation`
    # (a many2many table's row, :2274-2293) only insert what the database lacks: a module installed again after its
    # uninstall finds the rows it left (they have no xmlid). Recorded as placeholders with their arguments; the port
    # runs them (src/modules/reflect.ts). Inside `_reflect_constraints` they are part of that reflection already.
    def conditional(cls, name, kind, record):
        real = getattr(cls, name)

        def wrapper(self, *args):
            phase = state['phase']
            if phase in ('button', 'load') or phase.startswith('reflect '):
                return real(self, *args)
            n = len(state['reflect'])
            state['reflect'].append({'kind': kind, **record(self, *args)})
            state['log'].append((phase, f'@@reflect {n}@@', 0))
            state['phase'] = f'reflect {n}'
            try:
                return real(self, *args)
            finally:
                state['phase'] = phase
        setattr(cls, name, wrapper)
    conditional(irm.IrModelConstraint, '_reflect_constraint', 'constraint',
                lambda self, model, conname, type, definition, module, message=None:
                {'model': model._name, 'name': conname, 'type': type, 'definition': definition, 'module': module, 'message': message})
    conditional(irm.IrModelRelation, '_reflect_relation', 'relation',
                lambda self, model, table, module: {'model': model._name, 'name': table, 'module': module})

    # D23 path B, B2: the translation import's writes (`TranslationImporter.save`, translate.py:2199-2350) are not
    # replayed either. Each save in a translations phase leaves `@@translations <n>@@` and data['translations'][n]:
    #   model: the fields with translate=True, {model, table, field, entries: [module, name, {lang: value}]} in the
    #          importer's order; the runtime runs the same UPDATE over ir_model_data (keyed by xmlid, no id);
    #   terms: the term-translated fields (arch_db, html): per xmlid the languages and, by a fingerprint of the
    #          record's value (the keys `StoredTranslations.translated` reads), the changed values without and with
    #          overwrite. A record whose value has another fingerprint (its arch holds ids its data file gave, which
    #          differ in another database) refuses at runtime instead of guessing.
    from odoo.tools import translate as tr
    from odoo.tools import SQL as _SQL
    state['translations'] = []

    def term_fp(values, langs):
        keys = ['en_US', '_en_US'] + [k for lang in langs for k in (lang, '_' + lang)]
        keep_ = {k: values[k] for k in keys if k in values}
        text = json.dumps(keep_, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
        return hashlib.sha256(text.encode('utf-8')).hexdigest()

    def rec_save(importer, env, overwrite, force_overwrite):
        model = []
        for model_name, model_dictionary in importer.model_translations.items():
            for field_name, field_dictionary in model_dictionary.items():
                entries = [[*xmlid.split('.', 1), dict(translations)] for xmlid, translations in field_dictionary.items()]
                model.append({'model': model_name, 'table': env[model_name]._table, 'field': field_name, 'entries': entries})
        terms = []
        for model_name, model_dictionary in importer.model_terms_translations.items():
            Model = env[model_name]
            for field_name, field_dictionary in model_dictionary.items():
                field = Model._fields.get(field_name)
                kind = {tr.xml_translate: 'xml', tr.html_translate: 'html'}.get(field.translate, 'other')
                # the term updates by xmlid, without ids: the port translates its own record with them (B2 step 2,
                # src/modules/xml_translate.ts); by_fp, the build's result per value, checks it and serves html fields
                out = {xmlid: {'langs': sorted({lang for tr_ in src2.values() for lang in tr_}), 'by_fp': {},
                               'terms': {src: dict(tr_) for src, tr_ in src2.items()}}
                       for xmlid, src2 in field_dictionary.items()}
                params = [x.split('.', 1) for x in field_dictionary]
                for i in range(0, len(params), 1000):
                    rows = env.execute_query(_SQL(
                        "SELECT m.id, imd.module || '.' || imd.name, m.%s, imd.noupdate FROM %s m, \"ir_model_data\" imd "
                        "WHERE m.id = imd.res_id AND (%s)", _SQL.identifier(field_name), _SQL.identifier(Model._table),
                        _SQL(" OR ").join(_SQL("(imd.module = %s AND imd.name = %s)", *p) for p in params[i:i + 1000])))
                    for _id, xmlid, values, _noupdate in rows:
                        if not values or not values.get('_en_US', values['en_US']):
                            continue
                        term_updates = {}
                        for term_en, translations in field_dictionary[xmlid].items():
                            for lang, value in translations.items():
                                term_updates.setdefault(lang, {})[term_en] = value
                        langs = sorted(term_updates)
                        results = []
                        for do_overwrite in (False, True):
                            updated = dict(tr.StoredTranslations(values).translated(env, field, env.lang or 'en_US', term_updates, overwrite=do_overwrite))
                            changed = {}
                            for lang in term_updates:
                                if values.get(lang) != updated.get(lang):
                                    changed[lang] = updated.get(lang)
                                if f'_{lang}' in values:
                                    changed[f'_{lang}'] = None
                            results.append(changed)
                        out[xmlid]['by_fp'][term_fp(values, langs)] = results
                terms.append({'model': model_name, 'table': Model._table, 'field': field_name, 'translate': kind, 'records': out})
        return {'overwrite': overwrite, 'force_overwrite': force_overwrite, 'model': model, 'terms': terms}

    real_save = tr.TranslationImporter.save

    def save(self, overwrite=False, force_overwrite=False):
        before = state['phase']
        if not before.startswith('translations:') or not (self.model_translations or self.model_terms_translations):
            return real_save(self, overwrite=overwrite, force_overwrite=force_overwrite)
        n = len(state['translations'])
        self.env.flush_all()
        state['translations'].append(rec_save(self, self.env, overwrite, force_overwrite))
        state['log'].append((before, f'@@translations {n}@@', 0))
        state['phase'] = f'tsave {n}'
        try:
            return real_save(self, overwrite=overwrite, force_overwrite=force_overwrite)
        finally:
            state['phase'] = before
    tr.TranslationImporter.save = save

    # D23 path B, B3 (D24): `Field._init_column_data` (fields.py:1299-1345), the values of a new (or newly required)
    # column on the rows the table already has, is not replayed: what it wrote depends on the build's rows, not the
    # site's. Each call leaves `@@init_column <n>@@` and data['init_columns'][n]; its statements (the default's UPDATE) and
    # the later flush of the computed values (`UPDATE "<table>" SET "<field>" = "__tmp"...`) are left out, and the port
    # does both on its own rows at the end of the module's init phase (src/modules/install_columns.ts).
    from odoo.orm import fields as orm_fields
    state['init_columns'] = []
    real_icd = orm_fields.Field._init_column_data

    def init_column_data(self, model):
        before = state['phase']
        if not (before.startswith('init:') or before == 'end'):
            return real_icd(self, model)
        # fields.py:544-547: a constant default is wrapped in a lambda of fields.py
        constant = bool(self.default) and getattr(self.default, '__module__', '') == 'odoo.orm.fields' \
            and '_setup_attrs__.<locals>.<lambda>' in getattr(self.default, '__qualname__', '')
        rec = {'phase': before, 'model': model._name, 'table': model._table, 'field': self.name, 'type': self.type,
               'required': bool(self.required), 'init_storage': bool(getattr(self, 'init_storage', None)),
               'compute': bool(self.compute), 'default': None}
        # fields.py:1310-1312 `to_compute = determine(self.init_storage, model)`: a function that can only return a
        # constant (no names, no closure, one argument: l10n_kr_sale's `lambda model: None`) gives the same result on any
        # database, so its result is recorded; any other init_storage refuses in the port
        ins = getattr(self, 'init_storage', None)
        if callable(ins) and isinstance(ins, types.FunctionType) and not ins.__closure__ and not ins.__code__.co_names \
                and ins.__code__.co_argcount == 1:
            result = ins(model)
            if result is None or isinstance(result, bool) or result == 'default':
                rec['init_storage_result'] = {'value': result}
        # `lambda s: s.env._('<text>')` (partnership's res.company.partnership_label): `_init_column_data` runs in
        # init_models' environment (loading.py:188, registry.py:812: context {'module': ...}, no lang), where
        # environments.py:359 `env._` gives the source text on any database; only that exact code, in that environment
        fn = self.default
        if not constant and not self.init_storage and isinstance(fn, types.FunctionType) and not fn.__closure__ \
                and fn.__code__.co_argcount == 1 and fn.__code__.co_names == ('env', '_') \
                and [type(c) for c in fn.__code__.co_consts if c is not None] == [str] \
                and {i.opname for i in dis.get_instructions(fn)} <= {'RESUME', 'LOAD_FAST', 'LOAD_ATTR', 'LOAD_CONST', 'PUSH_NULL',
                                                                      'PRECALL', 'CALL', 'RETURN_VALUE', 'CACHE'} \
                and (model.env.lang or 'en_US') == 'en_US':
            constant = True
        if constant and not self.init_storage:
            # a constant default (fields.py wraps it in a lambda): its column value holds on any database
            value = self.convert_to_column_insert(self.convert_to_write(self.default(model), model), model)
            rec['default'] = {'value': value if not hasattr(value, 'adapted') else value.adapted}
        elif self.default:
            rec['default'] = {'callable': True}
        n = len(state['init_columns'])
        state['init_columns'].append(rec)
        state['log'].append((before, f'@@init_column {n}@@', 0))
        state['phase'] = f'icol {n}'
        try:
            return real_icd(self, model)
        finally:
            state['phase'] = before
    orm_fields.Field._init_column_data = init_column_data

    # the uninstall itself (`module_uninstall`: records, schema and reflection removed) is the port's
    # (src/modules/uninstall.ts): not kept
    real_module_uninstall = IrModuleModule.module_uninstall

    def module_uninstall(self):
        before = state['phase']
        state['phase'] = 'uninstall'
        try:
            return real_module_uninstall(self)
        finally:
            state['phase'] = before
    IrModuleModule.module_uninstall = module_uninstall

    real_load_data = loading.load_data
    state['steps'] = {}

    def load_data(env, idref, mode, kind, package):
        # VAGB B0: the registry while this module's data loads (registry.load per module, loading.py:181-188) is the
        # installed modules' and this one's; the generators' outputs on it, for every module but the graph's last
        if kind == 'data' and not (UPGRADE or UNINSTALL) and len(state['steps']) + 1 < len(state.get('to_install', ())):
            state['steps'][package.name] = step_outputs(env, f'stepgen:{package.name}')
        state['phase'] = f'{kind}:{package.name}'
        try:
            return real_load_data(env, idref, mode, kind, package)
        finally:
            state['phase'] = f'post:{package.name}'
    loading.load_data = load_data

    if UNINSTALL:
        # the modules installed first (Odoo's own install, not recorded), then their uninstall is
        with _odoo.env(commit=True) as env:
            mods = env['ir.module.module'].search([('name', 'in', MODULES)])
            if set(MODULES) - set(mods.mapped('name')):
                env['ir.module.module'].update_list()
                env.flush_all()
                env.cr.commit()
                mods = env['ir.module.module'].search([('name', 'in', MODULES)])
            if set(mods.mapped('state')) != {'installed'}:
                mods.button_immediate_install()
        state.update(phase='button', log=[], reflect=[], translations=[], init_columns=[])
    with _odoo.env(commit=True) as env:
        # a module on disk the base has no record of (a vendored OCA module, B6): "Update Apps List" first, as the
        # user does before installing it (the port's update_list creates the same record, gen/module_list.py `new`)
        known = set(env['ir.module.module'].search([('name', 'in', MODULES)]).mapped('name'))
        if set(MODULES) - known:
            env['ir.module.module'].update_list()
            env.flush_all()
            env.cr.commit()
        env.cr.execute(FINGERPRINT_SQL)
        fingerprint = env.cr.fetchone()[0]
        pre = snapshot(env.cr)
        mods = env['ir.module.module'].search([('name', 'in', MODULES)])
        assert sorted(mods.mapped('name')) == sorted(MODULES), mods.mapped('name')
        if UPGRADE:
            mods.button_upgrade()
        elif UNINSTALL:
            mods.button_uninstall()
        else:
            mods.button_install()
        env.cr.execute("SELECT name FROM ir_module_module WHERE state = %s ORDER BY name",
                       ['to upgrade' if UPGRADE else 'to remove' if UNINSTALL else 'to install'])
        to_install = [r[0] for r in env.cr.fetchall()]
        # the languages active when the install starts: a module's `_update_translations` that wrote nothing in them
        # leaves no translations phase, which the port then knows was empty (src/modules/install.ts)
        env.cr.execute("SELECT code FROM res_lang WHERE active ORDER BY code")
        langs = [r[0] for r in env.cr.fetchall()]
    state['phase'] = 'load'
    state['to_install'] = to_install
    Registry.new(_odoo.DB, update_module=True)
    steps = None
    if state['steps']:
        with _odoo.env() as fenv:
            final = step_outputs(fenv, 'stepgen:final')
        steps = steps_of(state['steps'], final, to_install, _odoo.OUT)

    phases = {}
    order = []
    reflect_sql = {}
    translations_sql = {}
    for phase, text, rowcount in state['log']:
        if phase.startswith('icol '):
            continue
        if init_flush(text, [c for c in state['init_columns'] if c['phase'] == phase]):
            continue
        if phase.startswith('reflect ') or phase.startswith('tsave '):
            if WRITE.match(text):
                (reflect_sql if phase.startswith('reflect ') else translations_sql).setdefault(phase.split()[1], []).append(text)
            continue
        if phase in ('button', 'load', 'uninstall') or not (text.startswith('@@') or keep(phase, text)):
            continue
        if phase not in phases:
            phases[phase] = []
            order.append(phase)
        phases[phase].append(text)
    replay_check = check_of(pre, phases, state['log'])
    data = {'base_fingerprint': fingerprint, 'replay_check': replay_check, 'init_columns': state['init_columns'], 'modules': to_install, 'order': order, 'phases': phases, 'now': NOW,
            'reflect': state['reflect'], 'reflect_sql': reflect_sql,
            'translations': state['translations'], 'translations_sql': translations_sql, 'langs': langs}
    if UPGRADE:
        from module_files import module_files
        data['files'] = {m: module_files(m, po_langs=()) for m in to_install}
        # loading.py:216 `module.write(module.get_values_from_terp(package.manifest))` before the data files
        from odoo.addons.base.models.ir_module import IrModuleModule
        from odoo.modules.module import Manifest
        data['terp'] = {m: IrModuleModule.get_values_from_terp(Manifest.for_addon(m)) for m in to_install}
        path = _odoo.write_json(os.path.join(_odoo.OUT, 'upgrade', f"{'+'.join(MODULES)}.json"), data)
    elif UNINSTALL:
        # what the load after the uninstall reflects again (loading.py:540-555 `models_to_check`, phase `end`) on the
        # registry without the modules: the port runs it after its own uninstall (src/modules/uninstall.ts)
        path = _odoo.write_json(os.path.join(_odoo.OUT, 'uninstall', f"{'+'.join(sorted(MODULES))}.json"), data)
    else:
        path = _odoo.write_json(os.path.join(_odoo.OUT, 'install_capture.json'), data)
        if steps is not None:
            # VAGB B0: src/orm/overlay.ts applies steps[<module>] while that module's data loads
            spath = _odoo.write_json(os.path.join(_odoo.OUT, 'install_steps.json'),
                                     {'_source': 'worker/gen/install_capture.py', 'order': list(state['steps']),
                                      # the unstepped files are the final ones at every step (steps_of checked it)
                                      'files': sorted([*STEP_FILES, *UNSTEPPED]),
                                      'steps': steps})
            print(f'{spath}: ' + ', '.join(f'{m} {sum(len(v.get(k, v)) if k else len(v) for n, v in p.items() for k in [STEP_FILES[n]])} entries'
                                          for m, p in steps.items()))
    print(f'{path}: {", ".join(f"{p} {len(phases[p])}" for p in order)}')


if __name__ == '__main__':
    main()
