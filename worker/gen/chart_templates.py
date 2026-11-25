"""chart_templates.py -> gen/out/<template>/chart/<code>.json: what `account.chart.template` reads from the modules'
files and Python template functions for one chart template (odoo/addons/account/models/chart_template.py), offline.

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy> .venv/bin/python worker/gen/chart_templates.py <code> [<code> ...]
The copy must have the template's module installed (for `se`: a copy of poc_erp with l10n_se installed); the
outputs are the same for every database with that module set, since they only depend on the module files and the
registry's fields. The Worker (src/models/chart_template.ts) loads them in `_load` with Odoo's own steps.

Per code:
  - `mapping`: `_get_chart_template_mapping(get_all=True)` (chart_template.py:108-129), the entries of the code and
    its parents (`_get_parent_template`, :1250-1256), and `parents` itself.
  - `template_data` and `data`: `_get_chart_template_data(code)` (:826-858), in Odoo's own
    order (lists of [model, [[xmlid, values], ...]], since JSON objects reorder integer-like keys). Two things depend
    on the database and are left to the runtime, both marked:
      * the company key of `@template(model='res.company')` functions is `self.env.company.id`; the generator runs
        with a sentinel company id and writes the key as "__company__";
      * `_deref_account_tags` (:1308-1315) maps tax tag names to ids of the database: skipped here, so the
        repartition lines keep `tag_ids` as the raw `||`-joined string the CSV gives.
    The functions are checked for any other use of the environment: a `self.env` other than `self.env.company.id`
    and `self.env.company.state_id.code` in a template function's source aborts the generator. l10n_us_account's
    `_get_us_res_company` picks the default taxes by the company's state: `res_company_by_state` holds the merged
    res.company values for each state code of the country where they differ from the stateless ones.
    The demo functions (`demo=True`) read the company's records and are not generated.
  - `translations`: `_get_field_translation(record, fname, lang)` (:1493-1514) for each record of `data`, each
    translatable field (`_get_translatable_template_model_fields`, :1415-1419) and the untranslatable ones translated
    anyway (`_get_untranslatable_fields_to_translate`, :1402-1413), for each lang in LANGS: what `_load_translations`
    (first part) and `_pre_load_data` (journal codes) use.
  - `code`: `get_python_translation(module, lang, value)` (:39-43) tables for the second part of `_load_translations`
    (records of the company with a missing translation, looked up by their en_US value in the code translations of
    their module and of account): module -> lang -> {source: translation}, the generic locale merged under the
    specific one, as the function falls back.
"""
import inspect
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

LANGS = ('en_US', 'fr_FR', 'sv_SE', 'ar_001')  # ar_001: l10n_gcc_invoice's post_init activates it (the Gulf sites)
SENTINEL = 987654321


def jsonable(v, path):
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        return v
    if isinstance(v, (list, tuple)):
        return [jsonable(x, f'{path}[{i}]') for i, x in enumerate(v)]
    if isinstance(v, dict):
        return {str(k): jsonable(x, f'{path}.{k}') for k, x in v.items()}
    raise TypeError(f'{path}: {type(v).__name__} {v!r} is not JSON')


def check_sources(register, only):
    """The template functions `_get_chart_template_data(code)` runs (:826-858: the codes None and the code's parents):
    the functions of other codes in the registry (other localizations installed in the same database) never run for it."""
    for demo, codes in register.items():
        if demo:
            continue  # the demo functions read the company's records: not generated (see `demo` below)
        for code, models in codes.items():
            if code not in only:
                continue
            for model, funcs in models.items():
                for f in funcs:
                    src = inspect.getsource(f)
                    # the attribute chain only: `company_values[self.env.company.id].update(...)` (the syscohada
                    # countries) keys by the company id as `{self.env.company.id: ...}` does; `self.env['x']` and
                    # `self.env.ref` stay `self.env` and `self.env.ref`, refused
                    for m in re.finditer(r'self\.env(?:\.\w+)*', src):
                        if m.group(0) not in ('self.env.company.id', 'self.env.company.state_id.code'):
                            raise SystemExit(f'{f.__qualname__} ({f._module}) uses {m.group(0)}: not generated offline')


def ordered(data):
    """{model: {xmlid: vals}} -> [[model, [[xmlid, vals], ...]], ...], the company key replaced by "__company__"."""
    out = []
    for model, records in data.items():
        rows = []
        for xmlid, vals in records.items():
            key = '__company__' if xmlid == SENTINEL else xmlid
            if isinstance(key, int):
                raise SystemExit(f'{model}: integer xmlid {key}')
            rows.append([key, jsonable(vals, f'{model}.{key}')])
        out.append([model, rows])
    return out


def main():
    codes = sys.argv[1:]
    if not codes:
        raise SystemExit('usage: chart_templates.py <code> [...]')
    with _odoo.env() as env:
        from odoo.tools.translate import code_translations
        # a sentinel company for `self.env.company.id` (only used as a key, checked in check_sources)
        Template = env['account.chart.template']
        register = Template._template_register
        cls = env.registry['account.chart.template']
        orig = cls._deref_account_tags
        cls._deref_account_tags = lambda self, template_code, tax_data: None
        try:
            # template functions read only `self.env.company.id` and `.state_id.code` (check_sources)
            from types import SimpleNamespace
            company = SimpleNamespace(id=SENTINEL, state_id=SimpleNamespace(code=False))
            T = Template.with_context(lang='en_US', allowed_company_ids=[1])
            # env.company is the first allowed company; browse a sentinel through the cache instead
            T = T.with_env(T.env(context={**T.env.context}))
            env_cls = type(T.env)
            orig_company = env_cls.__dict__['company']
            env_cls.company = property(lambda e: company)
            mapping = T._get_chart_template_mapping(get_all=True)
            translatable = T._get_translatable_template_model_fields()
            untranslatable = T._get_untranslatable_fields_to_translate()
            for code in codes:
                parents = T._get_parent_template(code)
                check_sources(register, {None, *parents})
                data = T._get_chart_template_data(code)
                template_data = dict(data.pop('template_data', {}))
                # the res.company values per state code of the company, when a function reads it
                by_state = {}
                country_id = mapping[code].get('country_id')
                states = env['res.country.state'].search([('country_id', '=', country_id)]).mapped('code') if country_id else []
                for st in states:
                    company.state_id.code = st
                    vals = T._get_chart_template_data(code).get('res.company', {}).get(SENTINEL)
                    if vals != data.get('res.company', {}).get(SENTINEL):
                        by_state[st] = jsonable(vals, f'res.company[{st}]')
                company.state_id.code = False
                translations = {}
                for model, records in data.items():
                    fields = [f for f in translatable.get(model, []) + untranslatable.get(model, [])]
                    for xmlid, record in records.items():
                        for fname in fields:
                            for lang in LANGS:
                                t = T._get_field_translation(record, fname, lang)
                                if t:
                                    key = '__company__' if xmlid == SENTINEL else xmlid
                                    translations.setdefault(lang, {}).setdefault(model, {}).setdefault(fname, {})[key] = t
                modules = sorted({mapping[c]['module'] for c in parents} | {'account'} |
                                 {m for recs in data.values() for r in recs.values()
                                  for m in r.get('__translation_module__', {}).values()})
                code_tables = {}
                for module in modules:
                    for lang in LANGS:
                        if lang == 'en_US':
                            continue
                        merged = dict(code_translations.get_python_translations(module, lang.split('_')[0]))
                        merged.update({k: v for k, v in code_translations.get_python_translations(module, lang).items() if v})
                        if merged:
                            code_tables.setdefault(module, {})[lang] = merged
                out = {
                    'code': code,
                    'parents': parents,
                    'mapping': {c: jsonable(mapping[c], c) for c in parents},
                    'template_data': jsonable(template_data, 'template_data'),
                    'data': ordered(data),
                    'res_company_by_state': by_state,
                    'translations': translations,
                    'code_translations': code_tables,
                    'langs': list(LANGS),
                }
                # not `write_json`: the records' key order is Odoo's dict order, which decides the order of the
                # create/write values (and so of the inverses: the ir.default rows of the company); JSON.parse keeps it
                path = os.path.join(_odoo.OUT, 'chart', f'{code}.json')
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(json.dumps(out, indent=1, ensure_ascii=False, allow_nan=False))
                    f.write('\n')
                n = sum(len(r) for _m, r in out['data'])
                print(f'{path}: {n} records in {len(out["data"])} models, {len(by_state)} state variants')
        finally:
            cls._deref_account_tags = orig
            if 'orig_company' in locals():
                env_cls.company = orig_company


if __name__ == '__main__':
    main()
