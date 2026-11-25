"""models.py -> gen/out/models.json: per-model and per-field Python-side metadata the DB does not hold.

Run: .venv/bin/python worker/gen/models.py   (registry of dev_gen, see _odoo.py)

Source of every key (Odoo 20, commit dd5d3718):
  model level, class attributes of odoo/odoo/orm/models.py BaseModel (lines 406-506) as resolved on the registry
  class by odoo/odoo/orm/model_classes.py (add_to_registry / _setup; _rec_name and _active_name defaults at
  model_classes.py:471-485):
    rec_name              _rec_name            rec_names_search  _rec_names_search     active_name  _active_name
    parent_store          _parent_store        parent_name       _parent_name
    check_inherits_access _check_inherits_access (models.py:463)  log_access  _log_access (models.py:241, 304)
    order  _order         description _description   transient _transient   abstract _abstract   table _table
    auto   _auto          inherits    _inherits (parent model -> link field)
    inherit               the Python `_inherit` parents of all class definitions of the model, in registration
                          order: keys of `_inherit_module` (model_classes.py:197, :219), value = introducing module
    modules               `_module` of every definition class in `_base_classes__` (model_classes.py:224), the
                          modules whose Python code contributes to the model, in MRO order (last wins)
  field level, attributes of odoo/odoo/orm/fields.py Field (lines 263-322) and subclasses:
    no_access     groups == NO_ACCESS ('.', odoo/odoo/orm/models.py:115); fields_get hides them for everyone
    compute       bool(compute)              fields.py:296    compute_sql  bool(compute_sql)     fields.py:299
    search        bool(search)               fields.py:301    inverse      bool(inverse)         fields.py:300
    store         store                      fields.py:289    depends      registry.field_depends[field]
                                                              (fields.py:1026 _description_depends)
    depends_context registry.field_depends_context[field]     related      related               fields.py:302
    inherited     inherited (an _inherits delegated field, model_classes.py:530)
    searchable    _description_searchable    fields.py:1030   sortable     _description_sortable(env) :1033
    groupable     _description_groupable(env) :1050           aggregator   _description_aggregator(env) :1071
    exportable    exportable                 fields.py:322    default_export_compatible              fields.py:321
    copy          copy (bool; a callable such as res.lang mark_as_copy is reported as "callable") fields.py:292
    readonly      readonly :310   required required :311     translate  translate (True/False, or the name of the
                  callable without the "_translate" suffix: "html" for html_translate, "xml" for xml_translate;
                  odoo/odoo/orm/fields_textual.py:30)
    company_dependent company_dependent :303 digits   get_digits(env) (fields_numeric.py:138, resolves the
                  decimal.precision name) and digits_raw = _digits (fields_numeric.py:112)
    size          size (Char)                string   string (untranslated label, fields.py:307)
    help          help (untranslated, fields.py:309)          type  type
    comodel_name  comodel_name (fields_relational.py:35)      inverse_name inverse_name (o2m, :920)
    relation      relation (m2m table, :1282)   column1/column2 (:1283, :1284)
    ondelete      ondelete (many2one :242 str; many2many :1285 str; selection: dict value -> policy,
                  fields_selection.py:66)
    groups        groups (csv of group xmlids, fields.py:312)
    selection     selection when it is a static list of pairs (fields_selection.py:64); else null and
                  selection_dynamic = true (a method name or callable, resolved per record set)
    bypass_search_access bypass_search_access (fields_relational.py:38)
    domain        domain when it is a static list (fields_relational.py:36); else null and domain_dynamic = true
    index         index (None, True or a string such as "btree_not_null", fields.py:290)
    prefetch      prefetch (fields.py:319)     recursive recursive (fields.py:295)
    compute_sudo  compute_sudo (fields.py:297) manual manual (fields.py:291)
    column_type   column_type[0] (the Postgres type, or null for non-stored / x2many)
    image         only on fields.Image (fields_binary.py:279): {max_width, max_height, verify_resolution}, what
                  Image._image_process resizes to (:344-387); absent on every other field
"""
import inspect
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

from odoo import fields  # noqa: E402
from odoo.orm.models import NO_ACCESS  # noqa: E402
from odoo.modules import module as modules_module  # noqa: E402


def _plain(value):
    """JSON-safe copy of a static attribute (tuples become lists; callables and other objects are tagged)."""
    if isinstance(value, (list, tuple)):
        return [_plain(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _plain(v) for k, v in value.items()}
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if callable(value):  # e.g. mail.message.message_type ondelete={'sms': lambda ...}: stable name, no address
        return {'__callable__': getattr(value, '__qualname__', type(value).__name__)}
    return {'__repr__': repr(value)}


def _static_callable_domain(env, field, domain):
    if not (field.relational and callable(domain)):
        return None
    try:
        src = inspect.getsource(domain)
    except (OSError, TypeError):
        return None
    if re.search(r'\benv\b|context|uid|\buser\b|compan', src):
        return None
    value = _plain(field._description_domain(env))
    # a lambda may read the environment through a method (calendar_event.py:172 -> _get_calendar_id_domain uses
    # env.uid): the value must also be the same for another user and language, else it is not static
    other_uid = 2 if env.uid != 2 else 1
    if _plain(field._description_domain(env(user=other_uid, context=dict(env.context, lang='fr_FR')))) != value:
        return None
    return value


def _translate(field):
    t = getattr(field, 'translate', False)
    if t is True or t is False:
        return t
    if callable(t):
        return t.__name__.removesuffix('_translate')
    return _plain(t)


def _copy(field):
    c = field.copy
    if c is True or c is False:
        return c
    return 'callable'


def field_info(env, field):
    selection = getattr(field, 'selection', None)
    static_selection = isinstance(selection, (list, tuple))
    domain = getattr(field, 'domain', None)
    static_domain = isinstance(domain, (list, tuple, str))
    digits_raw = getattr(field, '_digits', None)
    digits = None
    if field.type in ('float', 'monetary') and hasattr(field, 'get_digits'):
        digits = field.get_digits(env)
    try:
        aggregator = field._description_aggregator(env)
    except Exception as e:  # noqa: BLE001  (a few fields raise while building the SQL; recorded, not guessed)
        aggregator = {'__error__': repr(e)}
    try:
        sortable = field._description_sortable(env)
    except Exception as e:  # noqa: BLE001
        sortable = {'__error__': repr(e)}
    try:
        groupable = field._description_groupable(env)
    except Exception as e:  # noqa: BLE001
        groupable = {'__error__': repr(e)}
    info = {
        'type': field.type,
        'string': field.string,
        'help': field.help,
        'no_access': field.groups == NO_ACCESS,
        # Field.get_description properties and view onchange graph, not request snapshots.
        'change_default': field.change_default,
        'trim': getattr(field, 'trim', True),
        'attachment': getattr(field, 'attachment', False),
        'context': _plain(getattr(field, 'context', {})),
        'definition_record': getattr(field, 'definition_record', None),
        'definition_record_field': getattr(field, 'definition_record_field', None),
        'falsy_value_label': env._(field.falsy_value_label) if field.falsy_value_label else None,
        'min_display_digits': field.get_min_display_digits(env) if hasattr(field, 'get_min_display_digits') else None,
        'tracking': getattr(field, 'tracking', False) is not False,
        'tracking_sequence': env[field.model_name]._mail_track_get_field_sequence(field.name) if hasattr(env[field.model_name], '_mail_track_get_field_sequence') else None,
        'onchange': field.name in env[field.model_name]._onchange_methods,
        'onchange_dependents': sorted(f'{f.model_name}.{f.name}' for f in env.registry.get_dependent_fields(field.base_field)),
        'description_domain': _plain(field._description_domain(env)) if field.relational and not callable(domain) else None,
        'domain_callable': callable(domain),
        'group_expand': bool(field.group_expand),  # fields.py:1109 _description_group_expand
        # _description_domain (fields_relational.py:125) of a callable `domain=` whose source does not read the
        # environment (e.g. mail_thread.py:166 `lambda self: [('message_type', '!=', 'user_notification')]`):
        # the value only depends on the model, so it is static per registry; null when the lambda reads env/context
        'description_domain_static': _static_callable_domain(env, field, domain),
        'groups': field.groups,
        'compute': bool(field.compute),
        'compute_sudo': bool(field.compute_sudo),
        'compute_sql': bool(field.compute_sql),
        'search': bool(field.search),
        'inverse': bool(field.inverse),
        'store': bool(field.store),
        'depends': list(env.registry.field_depends[field]),
        'depends_context': list(env.registry.field_depends_context[field]),
        'related': field.related,
        'inherited': bool(field.inherited),
        'searchable': bool(field._description_searchable),
        'sortable': sortable,
        'groupable': groupable,
        'exportable': bool(field.exportable),
        'aggregator': aggregator,
        'default_export_compatible': bool(field.default_export_compatible),
        'copy': _copy(field),
        'readonly': bool(field.readonly),
        'required': bool(field.required),
        'translate': _translate(field),
        'company_dependent': bool(field.company_dependent),
        'digits': list(digits) if digits else None,
        'digits_raw': _plain(digits_raw) if digits_raw is not None else None,
        'size': getattr(field, 'size', None),
        'comodel_name': getattr(field, 'comodel_name', None) or None,
        'inverse_name': getattr(field, 'inverse_name', None),
        'relation': getattr(field, 'relation', None) if field.type == 'many2many' else None,
        'column1': getattr(field, 'column1', None) if field.type == 'many2many' else None,
        'column2': getattr(field, 'column2', None) if field.type == 'many2many' else None,
        'ondelete': _plain(getattr(field, 'ondelete', None)),
        'selection': _plain(selection) if static_selection else None,
        'selection_dynamic': bool(selection is not None and not static_selection),
        'bypass_search_access': bool(getattr(field, 'bypass_search_access', False)),
        'domain': _plain(domain) if static_domain and field.relational else None,
        'domain_dynamic': bool(field.relational and domain and not static_domain),
        'index': _plain(field.index),
        'prefetch': _plain(field.prefetch),
        'recursive': bool(field.recursive),
        'manual': bool(field.manual),
        'column_type': field.column_type[0] if field.column_type else None,
    }
    if isinstance(field, fields.Image):
        # fields_binary.py:279-298 Image: `_image_process` resizes to (max_width, max_height) and checks the resolution;
        # only on Image fields (their ttype is 'binary'), so the other fields' entries stay as they were
        info['image'] = {'max_width': field.max_width, 'max_height': field.max_height,
                         'verify_resolution': bool(field.verify_resolution)}
    return info


def model_info(env, model):
    cls = type(model)
    modules = []
    for base in cls._base_classes__:
        m = getattr(base, '_module', None)
        if m and m not in modules:
            modules.append(m)
    return {
        'rec_name': model._rec_name or None,
        'rec_names_search': list(model._rec_names_search or ()),
        'active_name': model._active_name,
        'parent_store': bool(model._parent_store),
        'parent_name': model._parent_name,
        'check_inherits_access': bool(model._check_inherits_access),
        'log_access': bool(getattr(model, '_log_access', model._auto)),
        'order': model._order,
        'description': model._description,
        'format_vat_label': 'format.vat.label.mixin' in cls._inherit_module,
        'format_address': 'format.address.mixin' in cls._inherit_module,
        'has_activities': 'mail.activity.mixin' in cls._inherit_module,
        'view_field_attributes': model._get_view_field_attributes(),
        'inherit': list(cls._inherit_module.keys()),
        'inherit_module': dict(cls._inherit_module),
        'inherits': dict(model._inherits),
        'modules': modules,
        # model_classes.py:196 `_original_module` (the module that defined the model), its icon as
        # mail/models/res_users.py:567-568 `_format_activity_group` computes it (modules/module.py:431 get_module_icon,
        # base icon when the module is unknown), and `_systray_view` (:584, default 'list')
        'original_module': cls._original_module or None,
        'original_module_icon': (cls._original_module and modules_module.get_module_icon(cls._original_module)) or '/base/static/description/icon.png',
        'systray_view': getattr(model, '_systray_view', 'list'),
        'transient': bool(model._transient),
        'abstract': bool(model._abstract),
        'auto': bool(model._auto),
        'table': model._table or None,
        'fields': {name: field_info(env, field) for name, field in sorted(model._fields.items())},
    }


def main():
    with _odoo.env() as env:
        out = {
            'db': env.cr.dbname,
            'odoo_commit': 'dd5d3718',
            'models': {name: model_info(env, env[name]) for name in sorted(env.registry.models)},
        }
    path = _odoo.write_models_json(os.path.join(_odoo.OUT, 'models.json'), out)
    nmodels = len(out['models'])
    nfields = sum(len(m['fields']) for m in out['models'].values())
    noaccess = sorted(f'{mn}.{fn}' for mn, m in out['models'].items() for fn, f in m['fields'].items() if f['no_access'])
    print(f'{path}: {nmodels} models, {nfields} fields, {len(noaccess)} NO_ACCESS fields')
    print('NO_ACCESS:', ', '.join(noaccess))


if __name__ == '__main__':
    main()
