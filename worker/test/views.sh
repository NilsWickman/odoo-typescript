#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ODOO_TEST_DB:?Set ODOO_TEST_DB to an existing poc_corpus scratch copy}"
export ODOO_VIEWS_ORACLE
ODOO_VIEWS_ORACLE=$(mktemp /tmp/odoo-views-oracle.XXXXXX.json)
PYTHONHASHSEED=0 ../.venv/bin/python test/views_oracle.py
node --experimental-transform-types --import ./test/register.mjs --test src/views/views.check.ts
