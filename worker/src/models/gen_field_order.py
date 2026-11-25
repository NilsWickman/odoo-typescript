#!/usr/bin/env python3
"""Generates src/models/field_order.json: per model, the field names in `model._fields` order, which is the order of
`fields_get()` (odoo/odoo/orm/models.py `fields_get` iterates `self._fields`) and hence of
`base_import.import.get_fields_tree` (addons/base_import/models/base_import.py:257-354). gen/out/models.json sorts
fields by name, so the order is kept here. Registry of dev_gen through gen/_odoo.py. Run from worker/:

    ../.venv/bin/python src/models/gen_field_order.py

This file belongs with gen/ (stream G); it lives here until the orchestrator moves it.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'gen'))
import _odoo  # noqa: E402

with _odoo.env() as env:
    order = {name: list(env[name]._fields) for name in sorted(env.registry.models)}
# per corpus template (_odoo.py GEN_TEMPLATE): field_order.json for poc_corpus, field_order_<template>.json otherwise
name = 'field_order.json' if _odoo.TEMPLATE == 'poc_corpus' else f'field_order_{_odoo.TEMPLATE}.json'
_odoo.write_json(os.path.join(HERE, name), order)
