"""`ir.module.module.update_list()` (base/models/ir_module.py:796-830) as the registry reload after a module operation runs
it (`_button_immediate_function` :608-665 -> `Registry.new(update_module=True)` -> modules/loading.py:400-403), for the
Worker (which cannot read the addons on disk):

  modules:      the names of the template's ir.module.module records that have a manifest in the addons path
                (`Manifest.all_addon_manifests()`): update_list writes each of them, at least `country_ids`
                (`_update_countries` :855-866, an assignment, so `write_date` changes even when the countries do not);
  fingerprint:  md5 of the columns and relations update_list compares with the manifests (FINGERPRINT_SQL, run the same
                way by src/modules/uninstall.ts): while it is unchanged, update_list changes nothing else;
  checked:      this generator ran update_list's own comparisons (values, the `uninstallable` state, dependencies,
                countries, exclusions, category) on the template and found no other change; a template where it would
                change something fails here instead of being written.

  new:          the modules on disk without a record (the vendored OCA ones): the record, XML id, dependencies,
                countries and exclusions update_list creates for them, read back from Odoo's own run (rolled back);
  versions:     each manifest's version (update_list's first count: a version above the record's latest_version).

Run with `GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/module_list.py` (a scratch copy of the template, GEN_DB).
Writes gen/out/<template>/module_list.json.
"""
import hashlib
import os

from _odoo import OUT, env, write_json

# Kept identical to FINGERPRINT_SQL in worker/src/modules/uninstall.ts.
FINGERPRINT_SQL = """
SELECT md5(COALESCE(string_agg(t.r, E'\\n' ORDER BY t.name), '')) || ':' ||
       (SELECT md5(COALESCE(string_agg(c.id || '|' || COALESCE(c.name::text, '') || '|' || COALESCE(c.parent_id::text, ''), E'\\n' ORDER BY c.id), ''))
          FROM ir_module_category c) || ':' ||
       (SELECT md5(COALESCE(string_agg(d.name || '|' || d.res_id, E'\\n' ORDER BY d.name), ''))
          FROM ir_model_data d WHERE d.module = 'base' AND d.model = 'ir.module.category') AS f
  FROM (SELECT m.name, concat_ws('|', m.name, m.description::text, m.shortdesc::text, m.author, m.maintainer, m.contributors,
                                 m.website, m.license, m.sequence, m.application, m.auto_install, m.icon, m.summary::text, m.url,
                                 m.to_buy, m.iap_paid_service, m.state = 'uninstallable', m.category_id,
               (SELECT string_agg(d.name || ':' || COALESCE(d.auto_install_required::text, ''), ',' ORDER BY d.name)
                  FROM ir_module_module_dependency d WHERE d.module_id = m.id),
               (SELECT string_agg(c.code, ',' ORDER BY c.code) FROM module_country r JOIN res_country c ON c.id = r.country_id
                 WHERE r.module_id = m.id),
               (SELECT string_agg(e.name, ',' ORDER BY e.name) FROM ir_module_module_exclusion e WHERE e.module_id = m.id)) AS r
          FROM ir_module_module m WHERE m.name = ANY(%s)) t
"""


def main():
    from odoo import modules
    with env() as e:
        Module = e['ir.module.module'].with_context(lang=None)
        known = {m.name: m for m in Module.search([])}
        names, problems, new, versions = [], [], [], {}
        countries_by_code = {c.code: c.id for c in e['res.country'].search([])}
        for manifest in modules.Manifest.all_addon_manifests():
            mod = known.get(manifest.name)
            versions[manifest.name] = Module.get_module_info(manifest).get('version')
            if not mod:
                new.append(manifest.name)
                continue
            names.append(mod.name)
            terp = Module.get_module_info(manifest)
            values = Module.get_values_from_terp(terp)
            changed = [k for k in values if (getattr(mod, k) or values[k]) and values[k] != getattr(mod, k)]
            if terp.get('installable', True) and mod.state == 'uninstallable':
                changed.append('state')
            depends = set(terp.get('depends', []))
            auto = set(terp.get('auto_install') or ())
            if {d.name for d in mod.dependencies_id} != depends or any(d.auto_install_required != (d.name in auto) for d in mod.dependencies_id):
                changed.append('dependencies')
            wanted = {countries_by_code[c.upper()] for c in terp.get('countries', []) if c.upper() in countries_by_code}
            if set(mod.country_ids.ids) != wanted:
                changed.append('countries')
            if {x.name for x in mod.exclusion_ids} != set(terp.get('excludes') or []):
                changed.append('exclusions')
            # :876-892 `_update_category`: another path writes the category that modules/db.py:158-194
            # `create_categories` resolves through the XML ids `base.module_category_<parts>` (renamed categories
            # keep theirs), creating the missing ones
            path, cat = [], mod.category_id
            while cat:
                path.insert(0, cat.name)
                cat = cat.parent_id
            categs = terp.get('category', 'Uncategorized').split('/')
            if categs != path:
                xml_id, resolved = 'module_category', None
                for part in categs:
                    xml_id += '_' + part.lower().replace('&', 'and').replace(' ', '_')
                    e.cr.execute("SELECT res_id FROM ir_model_data WHERE name=%s AND module=%s AND model=%s", (xml_id, 'base', 'ir.module.category'))
                    row = e.cr.fetchone()
                    resolved = row[0] if row else None
                    if resolved is None:
                        break
                if resolved is None or resolved != mod.category_id.id:
                    changed.append('category')
            if changed:
                problems.append(f'{mod.name}: {", ".join(changed)}')
        if problems:
            raise SystemExit('update_list would change more than the countries on this template:\n' + '\n'.join(problems))
        names.sort()
        e.cr.execute(FINGERPRINT_SQL, [names])
        fingerprint = e.cr.fetchone()[0]
        # the modules on disk the template has no record of (a vendored OCA module, B6): what update_list creates for
        # them (ir_module.py:819-824 `create`, :782-791 their `base.module_<name>`, `_update_from_terp`), read back
        # from Odoo's own update_list in a savepoint that is rolled back
        created = {}
        if new:
            e.cr.execute('SAVEPOINT module_list_new')
            Module.update_list()
            e.flush_all()
            skip = {'id', 'create_date', 'write_date', 'create_uid', 'write_uid'}
            for name in new:
                e.cr.execute("SELECT * FROM ir_module_module WHERE name = %s", [name])
                row = e.cr.dictfetchone()
                mid = row['id']
                e.cr.execute("SELECT module, name, model, noupdate FROM ir_model_data WHERE model = 'ir.module.module' AND res_id = %s ORDER BY id", [mid])
                imd = e.cr.dictfetchall()
                e.cr.execute("SELECT name, auto_install_required FROM ir_module_module_dependency WHERE module_id = %s ORDER BY id", [mid])
                deps = e.cr.dictfetchall()
                e.cr.execute("SELECT c.code FROM module_country r JOIN res_country c ON c.id = r.country_id WHERE r.module_id = %s ORDER BY c.code", [mid])
                countries = [r[0] for r in e.cr.fetchall()]
                e.cr.execute("SELECT name FROM ir_module_module_exclusion WHERE module_id = %s ORDER BY id", [mid])
                exclusions = [r[0] for r in e.cr.fetchall()]
                created[name] = {'row': {k: v for k, v in row.items() if k not in skip and v is not None},
                                 'xmlids': imd, 'dependencies': deps, 'countries': countries, 'exclusions': exclusions}
            e.cr.execute('ROLLBACK TO SAVEPOINT module_list_new')
        # the columns of fields other modules add to ir.module.module (base_import_module's `module_type` default):
        # update_list in the registry reload runs with base loaded only (loading.py:400), they are not set there
        reload_without = sorted(n for n, f in Module._fields.items() if f.store and n != 'id' and set(f._modules) != {'base'})
    path = write_json(os.path.join(OUT, 'module_list.json'), {
        'modules': names,
        'fingerprint': fingerprint,
        'new': created,
        'reload_without': reload_without if new else [],
        'versions': versions,
        'sql_sha256': hashlib.sha256(FINGERPRINT_SQL.encode()).hexdigest(),
    })
    print(path, len(names), 'modules')


if __name__ == '__main__':
    main()
