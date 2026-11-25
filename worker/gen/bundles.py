"""bundles.py -> gen/out/bundles/: precompiled lazy asset bundles and the ir_attachment rows Odoo creates for them.

Run: .venv/bin/python worker/gen/bundles.py

How Odoo serves a bundle the client loads lazily (loadBundle / loadCssFromBundle in web/static/src/core/assets.js):
  GET /web/bundle/<name>?lang=..   odoo/addons/web/controllers/webclient.py:110 WebClient.bundle ->
                                   ir.qweb._get_asset_nodes(name, css=True, js=True) (ir_qweb.py:2920) ->
                                   AssetsBundle.get_links() (assetsbundle.py:125): css link first, then js, URL
                                   /web/assets/<version>/<name>.min.<css|js> (ir_asset.py:88) where version is
                                   get_version() (assetsbundle.py:150): sha512[:7] of "<url>,<last_modified>" per
                                   file (WebAsset.unique_descriptor, :789; stylesheets add ",ltr," :994), with
                                   last_modified = os.path.getmtime of the source file (ir_asset.py:48). No compile.
  GET /web/assets/<version>/<file> odoo/addons/web/controllers/binary.py:99-150: an existing public ir.attachment
                                   with that url is streamed; otherwise the bundle is compiled now and saved
                                   (AssetsBundle.css() :523 / .js() :351 -> save_attachment :292): name=<file>,
                                   mimetype text/css or application/javascript, res_model ir.ui.view, res_id 0,
                                   type binary, public true, raw=content.encode('utf8'), url=/web/assets/<version>/<file>.
                                   ir.attachment fills checksum = sha1(raw), store_fname = <sha1[:2]>/<sha1>,
                                   file_size, index_content (text/* only, ir_attachment.py:561 _index) and
                                   company_id of the superuser's company.
This script replays exactly that on dev_gen: for each bundle name it removes the bundle's existing attachments
inside the transaction (so .css()/.js() compile instead of returning the stored row), compiles with Odoo's own
AssetsBundle, reads the row back and the bytes, writes them out, then ROLLS BACK (dev_gen keeps poc_corpus's rows;
the filestore of dev_gen may gain the sha1-named file, harmless). For bundles poc_corpus already holds (ir_attachment
url like '/web/assets/%') the recompiled checksum is compared with the stored one and reported.

Bundle names: the literal loadBundle("...") / loadCssFromBundle(..., "...") names found by scanning the installed
modules' static/src (web/static/src/core/assets.js API) plus the two the S1 reference requests under /web/bundle/
(web.assets_emoji, mail.assets_message_email). Names passed as variables (this.props.bundle, bundleName) cannot be
enumerated statically; a bundle not listed here raises NotPorted in the Worker.

Outputs: gen/out/bundles/<name>.min.css|js and gen/out/bundles/index.json:
  {name: {"bundle_response": the /web/bundle/<name> JSON, "css"/"js": {attachment row without id and dates, "file",
          "sha256", "in_poc_corpus": existing row id or null, "poc_corpus_checksum_matches": bool|null},
          "files": the source urls of the bundle}}
"""
import hashlib
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

from odoo.modules.module import get_module_path  # noqa: E402

OUT = os.path.join(_odoo.OUT, 'bundles')
# requested by the S1 reference (harness/corpus/runtime/ref/frozen-2026-10-28/S1/exchanges.jsonl seq 323, 324)
S1_BUNDLES = ('web.assets_emoji', 'mail.assets_message_email')
# loaded by a conditional expression the scan misses (web/static/src/views/view.js:363-365); C1 seq 69 requests it
C1_BUNDLES = ('web.assets_backend_lazy',)
# an overlay template (GEN_TEMPLATE=<overlay>, GEN_DB=a copy of its base with the overlay's modules installed by Odoo):
# also the bundles the pages link (stored as attachments in the base template), and only the files whose version
# differs from the base's: Odoo compiles those on the first request after the install (binary.py:120-149), the
# Worker saves them from here (src/controllers/assets.ts)
PAGE_BUNDLES = ('web.assets_web', 'web.assets_web_print', 'web.assets_frontend', 'web.assets_frontend_lazy',
                'web.assets_frontend_minimal')
RX_LOAD = re.compile(r'''load(?:Bundle|CssFromBundle)\((?:[^,()]*,\s*)?["']([a-z_0-9]+\.[a-z_0-9]+)["']''')
ROW_COLUMNS = ('name', 'url', 'mimetype', 'checksum', 'store_fname', 'file_size', 'res_model', 'res_id', 'res_field',
               'public', 'type', 'index_content', 'description', 'access_token', 'company_id', 'original_id',
               'create_uid', 'write_uid', 'db_datas')


def scan_bundle_names(env):
    env.cr.execute("SELECT name FROM ir_module_module WHERE state = 'installed' ORDER BY name")
    found = {}
    for (module,) in env.cr.fetchall():
        src = os.path.join(get_module_path(module), 'static', 'src')
        if not os.path.isdir(src):
            continue
        for dirpath, _dirs, files in os.walk(src):
            for fn in files:
                if not fn.endswith('.js'):
                    continue
                path = os.path.join(dirpath, fn)
                with open(path, encoding='utf-8', errors='replace') as f:
                    for name in RX_LOAD.findall(f.read()):
                        found.setdefault(name, set()).add(os.path.relpath(path, _odoo.ROOT))
    return {k: sorted(v) for k, v in found.items()}


def existing_rows(env):
    env.cr.execute("SELECT id, name, url, checksum FROM ir_attachment WHERE url LIKE '/web/assets/%' ORDER BY url")
    return {r['name']: dict(r) for r in env.cr.dictfetchall()}


def row_of(env, attachment):
    env.flush_all()
    env.cr.execute(f"SELECT {', '.join(ROW_COLUMNS)} FROM ir_attachment WHERE id = %s", [attachment.id])
    row = env.cr.dictfetchone()
    assert row['db_datas'] is None  # bytes live in the filestore (store_fname), never in the table
    return row


def compile_bundle(env, name, existing):
    qweb = env['ir.qweb']
    # the /web/bundle controller: _get_asset_nodes -> _get_asset_links (rtl from env.lang, assets_params from
    # ir.asset._get_asset_params) -> get_links (ir_qweb.py:2920-2947, assetsbundle.py:125)
    nodes = qweb._get_asset_nodes(name, css=True, js=True)
    response = [{'type': tag, 'src': attrs.get('src') or attrs.get('data-src') or attrs.get('href')}
                for tag, attrs in nodes]
    bundle = qweb._get_asset_bundle(name, css=True, js=True, rtl=False)
    result = {'bundle_response': response, 'files': [f['url'] for f in bundle.files]}
    for ext, has in (('css', bool(bundle.stylesheets)), ('js', bool(bundle.javascripts or bundle.templates))):
        if not has:
            continue
        fname = f'{name}.min.{ext}'
        prior = existing.get(fname)
        # force a fresh compile: drop the stored rows for this bundle (rolled back at the end)
        env.cr.execute("DELETE FROM ir_attachment WHERE url LIKE %s", [f'/web/assets/%/{fname}'])
        env.invalidate_all()
        attachment = bundle.css() if ext == 'css' else bundle.js()
        attachment = attachment[0] if len(attachment) > 1 else attachment
        raw = bytes(attachment.raw)  # BinaryValue.__bytes__ (odoo/odoo/tools/binary.py:45)
        row = row_of(env, attachment)
        assert row['checksum'] == hashlib.sha1(raw).hexdigest() == row['store_fname'].split('/')[1]
        assert row['file_size'] == len(raw)
        assert response and any(r['src'] == row['url'] for r in response), (row['url'], response)
        with open(os.path.join(OUT, fname), 'wb') as f:
            f.write(raw)
        row.update({
            'file': fname,
            'sha256': hashlib.sha256(raw).hexdigest(),
            'in_poc_corpus': prior['id'] if prior else None,
            'poc_corpus_checksum_matches': (prior['checksum'] == row['checksum']) if prior else None,
            'poc_corpus_url_matches': (prior['url'] == row['url']) if prior else None,
        })
        result[ext] = row
    return result


def overlay_base():
    """For an overlay template: the urls of its base's compiled bundles (the base's lazy index), else None."""
    templates = _odoo.json.load(open(os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', 'templates.json')))
    t = templates.get(_odoo.TEMPLATE, {})
    if not t.get('overlay'):
        return None
    base = os.path.join(_odoo.ROOT, 'worker', 'gen', 'out', t['dir'], 'bundles', 'index.json')
    index = _odoo.json.load(open(base))
    return {r['url'] for n, e in index.items() if n != '_meta' for k, r in e.items() if k in ('css', 'js')}


def main():
    os.makedirs(OUT, exist_ok=True)
    base_urls = overlay_base()
    with _odoo.env() as env:  # rolled back on exit
        assert env.lang == 'en_US', env.lang
        scanned = scan_bundle_names(env)
        names = sorted(set(scanned) | set(S1_BUNDLES) | set(C1_BUNDLES) | (set(PAGE_BUNDLES) if base_urls is not None else set()))
        existing = existing_rows(env)
        if base_urls is not None:  # the base template's stored page bundles (the copy has not compiled any since)
            base_urls |= {r['url'] for r in existing.values()}
        index = {'_meta': {
            'db': env.cr.dbname,
            'lang': env.lang,
            'poc_corpus_bundle_attachments': {n: {'id': r['id'], 'url': r['url'], 'checksum': r['checksum']}
                                              for n, r in sorted(existing.items())},
            'scanned_from': scanned,
            's1_requested': list(S1_BUNDLES),
            'empty': [],
        }}
        for name in names:
            with env.cr.savepoint():
                result = compile_bundle(env, name, existing)
            if not result['bundle_response']:
                index['_meta']['empty'].append(name)
                print(f'{name}: no files (not emitted)')
                continue
            if base_urls is not None:
                for ext in ('css', 'js'):
                    # a page bundle only where the base template stores it (the pages link the stored files)
                    page_unstored = name in PAGE_BUNDLES and f'{name}.min.{ext}' not in existing
                    if ext in result and (result[ext]['url'] in base_urls or page_unstored):
                        os.remove(os.path.join(OUT, result[ext]['file']))
                        del result[ext]
                if 'css' not in result and 'js' not in result:
                    print(f'{name}: as in the base template (not emitted)')
                    continue
            index[name] = result
            for ext in ('css', 'js'):
                if ext in result:
                    r = result[ext]
                    print(f'{name}.min.{ext}: url={r["url"]} sha1={r["checksum"]} size={r["file_size"]}'
                          f' in_poc_corpus={r["in_poc_corpus"]} checksum_matches={r["poc_corpus_checksum_matches"]}')
    _odoo.write_json(os.path.join(OUT, 'index.json'), index)


if __name__ == '__main__':
    main()
