"""report_bundles.py -> entries of gen/out/<template>/bundles/index.json and the bytes: `web.report_assets_common` as Odoo
compiles it for the report pages (web.report_layout: t-autoprefix) and the layout wizard preview, with Odoo's own
AssetsBundle (same replay as gen/bundles.py, rolled back).

The bundle includes `/web/static/asset_styles_company_report.scss`, the attachment `_update_asset_style` rewrites from
`web.styles_company_report` when a company's layout or colours change, so its bytes depend on those values: one
variant per style. `default` is the template's state; the others apply the company values of the documented layout
wizard run on the demo logo (base.document.layout on company 1: colours extracted from the logo, 'Light' layout).

Run: GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/report_bundles.py
"""
import hashlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

OUT = os.path.join(_odoo.OUT, 'bundles')
NAME = 'web.report_assets_common'
VARIANTS = {
    'default': None,
    # company 1 after base.document.layout (primary/secondary from web.base.document.layout logo, Light layout)
    'c1_5e4766_010101_light': {'primary_color': '#5e4766', 'secondary_color': '#010101', 'external_report_layout_id': 'web.external_layout_standard'},
}


def compile_one(env, autoprefix, ext, name=NAME):
    qweb = env['ir.qweb']
    bundle = qweb._get_asset_bundle(name, css=ext == 'css', js=ext == 'js', rtl=False, autoprefix=autoprefix)
    fname = f'{name}{".autoprefixed" if autoprefix and ext == "css" else ""}.min.{ext}'
    env.cr.execute("DELETE FROM ir_attachment WHERE url LIKE %s", [f'/web/assets/%/{fname}'])
    env.invalidate_all()
    attachment = bundle.css() if ext == 'css' else bundle.js()
    attachment = attachment[0] if len(attachment) > 1 else attachment
    raw = bytes(attachment.raw)
    env.flush_all()
    env.cr.execute("SELECT name, url, mimetype, checksum, store_fname, file_size FROM ir_attachment WHERE id = %s", [attachment.id])
    return fname, env.cr.dictfetchone(), raw


def main():
    os.makedirs(OUT, exist_ok=True)
    index = {}
    with _odoo.env() as env:
        for variant, values in VARIANTS.items():
            with env.cr.savepoint(flush=False) as sp:
                if values:
                    company = env['res.company'].browse(1)
                    vals = dict(values)
                    vals['external_report_layout_id'] = env.ref(vals['external_report_layout_id']).id
                    company.write(vals)
                    env.flush_all()
                entry = {}
                for autoprefix, ext in ((False, 'css'), (True, 'css'), (False, 'js')):
                    fname, row, raw = compile_one(env, autoprefix, ext)
                    out = f'report-{variant}-{fname}'
                    with open(os.path.join(OUT, out), 'wb') as f:
                        f.write(raw)
                    entry[fname] = {**row, 'file': out, 'sha256': hashlib.sha256(raw).hexdigest(), 'index_content': None, 'company_id': None}
                    print(variant, fname, row['url'], row['file_size'], entry[fname]['sha256'])
                index[variant] = entry
                sp.rollback()
    # entries of the bundle index under `<bundle>|<variant>[|auto]` (src/controllers/assets.ts `reportBundleFile`)
    path = os.path.join(OUT, 'index.json')
    with open(path, encoding='utf-8') as f:
        merged = json.load(f)
    for variant, entry in index.items():
        merged[f'{NAME}|{variant}'] = {'bundle_response': [], 'files': [], 'css': entry[f'{NAME}.min.css'], 'js': entry[f'{NAME}.min.js']}
        merged[f'{NAME}|{variant}|auto'] = {'bundle_response': [], 'files': [], 'css': entry[f'{NAME}.autoprefixed.min.css']}
    # web.report_assets_pdf (web.minimal_layout, the html of the PDF engine): one css file, no company styles; its
    # js call renders nothing (no script in the bundle)
    with _odoo.env() as env:
        with env.cr.savepoint(flush=False) as sp:
            fname, row, raw = compile_one(env, True, 'css', 'web.report_assets_pdf')
            out = f'report-{fname}'
            with open(os.path.join(OUT, out), 'wb') as f:
                f.write(raw)
            print('pdf', fname, row['url'], row['file_size'])
            merged['web.report_assets_pdf|auto'] = {'bundle_response': [], 'files': [], 'css': {
                **row, 'file': out, 'sha256': hashlib.sha256(raw).hexdigest(), 'index_content': None, 'company_id': None}}
            sp.rollback()
    _odoo.write_json(path, merged)


if __name__ == '__main__':
    main()
