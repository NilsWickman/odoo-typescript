"""install_reflection.py <overlay> <base db> <installed db>: the schema and registry reflection of installing an
overlay's modules (gen/out/templates.json: poc_erp_se is poc_erp plus l10n_se), as Odoo's own install wrote them.

Installing a module runs `registry.init_models` for the models it loads and their descendants (odoo/modules/
loading.py `load_module_graph`; odoo/orm/registry.py:812-867): `_auto_init` (new columns, their initial values),
`ir.model._reflect_models`, `ir.model.fields._reflect_fields`, `ir.model.fields.selection._reflect_selections`,
constraints and inherits, the xmlids of these rows (ir_model.py:503-540, :1367-1428, :1761-1820), then indexes and
foreign keys. What it writes depends on the registry *during* the install: the modules loaded before the new one in
the graph, not the final registry (the final `res.company._module` is sale_stock; at l10n_se's turn it is l10n_se).
So this generator does not recompute it: it reads the net effect of Odoo's install of the same modules on a copy of
the base template (`<installed db>`, e.g. `odoo-bin -d <copy of poc_erp> -i l10n_se --stop-after-init`) against
`<base db>`, in Odoo's order (ids ascending), with every row keyed by its natural key instead of its id:

  columns:    [table, column, udt type, is_nullable, comment, init] for new columns; `init` is the value every
              pre-existing row got (`_init_column_data`), or null
  indexes, foreign_keys: new ones, by their definition
  models:     ir_model rows added or changed (values without id), keyed by `model`
  fields:     ir_model_fields rows added or changed, keyed by (model, name); `model_id` as the model's name
  selections: ir_model_fields_selection rows added or changed, keyed by (model, field, value); changed rows carry the
              changed columns only
  xmlids:     ir_model_data rows added for those three models: (module, name, model, key, noupdate)
  fingerprint: md5 of the base's reflection rows of the models concerned (the same SQL as src/modules/install.ts):
              the port replays this only on a database whose rows are still the template's

Anything else of the reflection (ir_model_constraint, ir_model_inherit, ir_model_relation, a changed or removed
column) fails here instead of being written: the port does not replay it.
Writes gen/out/<overlay>/install_reflection.json.
"""
import json
import os
import sys

import psycopg2

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out')

# Kept identical to FINGERPRINT_SQL in worker/src/modules/install.ts.
FINGERPRINT_SQL = """
SELECT md5(COALESCE((SELECT string_agg(concat_ws('|', m.model, m.name::text, m.info, m.state, m."order", m.transient, m.abstract), E'\\n' ORDER BY m.model)
                       FROM ir_model m WHERE m.model = ANY(%(models)s)), '')
        || COALESCE((SELECT string_agg(concat_ws('|', f.model, f.name, f.ttype, f.store, f.relation, f.required, f.readonly, f.field_description::text, f.state), E'\\n' ORDER BY f.model, f.name)
                       FROM ir_model_fields f WHERE f.model = ANY(%(models)s)), '')
        || COALESCE((SELECT string_agg(concat_ws('|', f.model, f.name, s.value, s.sequence, s.name::text), E'\\n' ORDER BY f.model, f.name, s.value)
                       FROM ir_model_fields_selection s JOIN ir_model_fields f ON f.id = s.field_id WHERE f.model = ANY(%(models)s)), '')) AS f
"""


def connect(db):
    return psycopg2.connect(host='127.0.0.1', port=5433, user='odoo', password='odoo', dbname=db)


def rows(cr, sql, params=None):
    cr.execute(sql, params or {})
    cols = [d[0] for d in cr.description]
    return [dict(zip(cols, r)) for r in cr.fetchall()]


def jsonable(v):
    if hasattr(v, 'isoformat'):
        return v.isoformat()
    return v


def table_rows(cr, sql):
    return {tuple(r.pop('_key')): {k: jsonable(v) for k, v in r.items()} for r in rows(cr, sql)}


DROP = {'id', 'create_uid', 'create_date', 'write_uid', 'write_date'}

MODEL_SQL = "SELECT ARRAY[model] AS _key, * FROM ir_model ORDER BY id"
FIELD_SQL = """SELECT ARRAY[f.model, f.name] AS _key, f.*, m.model AS model_id FROM ir_model_fields f
               JOIN ir_model m ON m.id = f.model_id ORDER BY f.id"""
SEL_SQL = """SELECT ARRAY[f.model, f.name, s.value] AS _key, s.*, NULL AS field_id FROM ir_model_fields_selection s
             JOIN ir_model_fields f ON f.id = s.field_id ORDER BY s.id"""


def diff(base, new, last):
    """Rows of `new` absent from `base` (whole, without ids, with `offset`: the row's id less the base's last sequence
    value, less one) or changed (the changed columns), in `new`'s order."""
    out = []
    for key, row in new.items():
        old = base.get(key)
        vals = {k: v for k, v in row.items() if k not in DROP}
        if old is None:
            out.append({'key': list(key), 'added': True, 'offset': row['id'] - last - 1, 'values': vals})
        else:
            changed = {k: v for k, v in vals.items() if old.get(k) != v}
            if changed:
                out.append({'key': list(key), 'added': False, 'values': changed})
    gone = [list(k) for k in base if k not in new]
    return out, gone


def main():
    overlay, base_db, new_db = sys.argv[1], sys.argv[2], sys.argv[3]
    b, n = connect(base_db).cursor(), connect(new_db).cursor()
    problems = []

    # schema
    col_sql = """SELECT c.table_name, c.column_name, c.udt_name, c.is_nullable,
                        col_description(format('%%I', c.table_name)::regclass, c.ordinal_position) AS comment
                   FROM information_schema.columns c JOIN information_schema.tables t
                     ON t.table_name = c.table_name AND t.table_schema = c.table_schema AND t.table_type = 'BASE TABLE'
                  WHERE c.table_schema = 'public' ORDER BY c.table_name, c.ordinal_position"""
    bcols = {(r['table_name'], r['column_name']): r for r in rows(b, col_sql)}
    ncols = {(r['table_name'], r['column_name']): r for r in rows(n, col_sql)}
    btables = {t for t, _ in bcols}
    columns = []
    for key, r in ncols.items():
        if key in bcols:
            o = bcols[key]
            if (o['udt_name'], o['is_nullable']) != (r['udt_name'], r['is_nullable']):
                problems.append(f'column changed: {key}')
            continue
        table, column = key
        if table not in btables:
            problems.append(f'new table: {table}')
            continue
        # the value the rows that existed before the install got: the rows of the base, by id
        b.execute(f'SELECT max(id) FROM "{table}"')
        maxid = b.fetchone()[0]
        init = None
        if maxid is not None:
            n.execute(f'SELECT DISTINCT "{column}"::text FROM "{table}" WHERE id <= %s', [maxid])
            values = [v for (v,) in n.fetchall()]
            if len(values) > 1:
                problems.append(f'{table}.{column}: pre-existing rows got {len(values)} values ({values[:5]})')
            init = values[0] if values else None
        columns.append({'table': table, 'column': column, 'type': r['udt_name'], 'nullable': r['is_nullable'] == 'YES',
                        'comment': r['comment'], 'init': init})
    for key in bcols:
        if key not in ncols:
            problems.append(f'column dropped: {key}')

    idx_sql = "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname"
    bidx = {r['indexname']: r['indexdef'] for r in rows(b, idx_sql)}
    indexes = [{'name': r['indexname'], 'def': r['indexdef']} for r in rows(n, idx_sql)
               if bidx.get(r['indexname']) != r['indexdef']]
    fk_sql = """SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def FROM pg_constraint
                 WHERE connamespace = 'public'::regnamespace ORDER BY conname"""
    bfk = {(r['tbl'], r['conname']): r['def'] for r in rows(b, fk_sql)}
    constraints = [{'table': r['tbl'], 'name': r['conname'], 'def': r['def']} for r in rows(n, fk_sql)
                   if bfk.get((r['tbl'], r['conname'])) != r['def']]

    # reflection: one upsert per table (`upsert_en`), each of its rows takes a sequence value, inserted or not
    def last(cr, table):
        cr.execute(f"SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM {table}_id_seq")
        return cr.fetchone()[0]
    seq = {t: last(b, t) for t in ('ir_model', 'ir_model_fields', 'ir_model_fields_selection', 'ir_model_data')}
    models, gone = diff(table_rows(b, MODEL_SQL), table_rows(n, MODEL_SQL), seq['ir_model'])
    problems += [f'ir_model removed: {k}' for k in gone]
    fields, gone = diff(table_rows(b, FIELD_SQL), table_rows(n, FIELD_SQL), seq['ir_model_fields'])
    problems += [f'ir_model_fields removed: {k}' for k in gone]
    selections, gone = diff(table_rows(b, SEL_SQL), table_rows(n, SEL_SQL), seq['ir_model_fields_selection'])
    problems += [f'ir_model_fields_selection removed: {k}' for k in gone]
    for r in selections:
        r['values'].pop('field_id', None)
    for t in ('ir_model_constraint', 'ir_model_inherit', 'ir_model_relation'):
        b.execute(f'SELECT count(*) FROM {t}')
        n.execute(f'SELECT count(*) FROM {t}')
        if b.fetchone() != n.fetchone():
            problems.append(f'{t} changed')

    # what each table's sequence moved in all: at least one value per upserted row, more when the reflection with the
    # partial registry wrote a row that the reflection with the full one (STEP 5.5 `_models_to_check`) wrote back
    sequences = {}
    for table, rs in (('ir_model', models), ('ir_model_fields', fields), ('ir_model_fields_selection', selections)):
        n.execute(f"SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM {table}_id_seq")
        sequences[table] = n.fetchone()[0] - seq[table]
        if sequences[table] < len(rs):
            problems.append(f'{table}: the install took {sequences[table]} sequence values for {len(rs)} rows')
    maxdata = seq['ir_model_data']
    xmlids = []
    for r in rows(n, """
            SELECT d.id - %(maxdata)s - 1 AS offset, d.module, d.name, d.model, d.noupdate,
                   CASE d.model WHEN 'ir.model' THEN ARRAY[m.model]
                                WHEN 'ir.model.fields' THEN ARRAY[f.model, f.name]
                                ELSE ARRAY[sf.model, sf.name, s.value] END AS key
              FROM ir_model_data d
              LEFT JOIN ir_model m ON d.model = 'ir.model' AND m.id = d.res_id
              LEFT JOIN ir_model_fields f ON d.model = 'ir.model.fields' AND f.id = d.res_id
              LEFT JOIN ir_model_fields_selection s ON d.model = 'ir.model.fields.selection' AND s.id = d.res_id
              LEFT JOIN ir_model_fields sf ON sf.id = s.field_id
             WHERE d.id > %(maxdata)s AND d.model IN ('ir.model', 'ir.model.fields', 'ir.model.fields.selection')
             ORDER BY d.id""", {'maxdata': maxdata}):
        xmlids.append(r)

    # `_update_xmlids` inserts every xmlid of the reflected rows, existing ones too (ON CONFLICT): each takes a value of
    # ir_model_data_id_seq. What the reflection took in all, up to the first other xmlid of the install
    n.execute("SELECT min(id) FROM ir_model_data WHERE id > %s", [maxdata + 1 + max([x['offset'] for x in xmlids], default=-1)])
    following = n.fetchone()[0]
    if following is None:
        problems.append('no xmlid after the reflection: what it took of ir_model_data_id_seq is not known')
    xmlid_seq = (following or 0) - maxdata - 1
    # the end of the load (loading.py:478-491, `init_models` of the models whose fields are no longer translated)
    # reflects them again: their xmlids, existing ones, take values of ir_model_data_id_seq after the install's last
    # xmlid (no row): what the sequence moved past the last id
    n.execute("SELECT (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM ir_model_data_id_seq) - max(id) FROM ir_model_data")
    xmlid_tail = n.fetchone()[0]
    concerned = sorted({r['key'][0] for r in models} | {r['key'][0] for r in fields} | {r['key'][0] for r in selections})
    b.execute(FINGERPRINT_SQL, {'models': concerned})
    fingerprint = b.fetchone()[0]

    if problems:
        print('not replayable:\n  ' + '\n  '.join(problems))
        sys.exit(1)
    data = {'base': base_db, 'columns': columns, 'indexes': indexes, 'constraints': constraints, 'models': models,
            'fields': fields, 'selections': selections, 'xmlids': xmlids, 'sequences': {**sequences, 'ir_model_data': xmlid_seq}, 'tail': {'ir_model_data': xmlid_tail}, 'concerned': concerned,
            'fingerprint': fingerprint}
    path = os.path.join(OUT, overlay, 'install_reflection.json')
    with open(path, 'w', encoding='utf-8') as f:
        f.write(json.dumps(data, sort_keys=True, indent=1, ensure_ascii=False, default=str) + '\n')
    print(f'{path}: {len(columns)} columns, {len(indexes)} indexes, {len(constraints)} constraints, {len(models)} models, '
          f'{len(fields)} fields, {len(selections)} selections, {len(xmlids)} xmlids')


if __name__ == '__main__':
    main()
