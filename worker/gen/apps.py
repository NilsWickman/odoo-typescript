"""Facts of the addons on disk that Odoo reads from module files at runtime, for the Worker (no file access):

  charts:  `account.chart.template._get_chart_template_mapping()` (account/models/chart_template.py:108-129), in its
           order, with the template code, the label (en_US), the country id and the module;
  modules: per ir.module.module name, `icon_flag` and `icon_image` (`_get_icon_image`, base/models/ir_module.py:254-277),
           `installed_version` (`_get_latest_version` :217-220, the manifest) and `description_html` (`_get_desc`
           :181-215, the rendered static/description/index.html or description);
  icons:   the icon bytes (base64) by sha256 (many modules share one file);
  rating_images: rating/static/src/img/rating_<threshold>.png (`_compute_rating_image`, rating/models/rating.py:102-113).

Run from anywhere with `GEN_TEMPLATE=poc_erp .venv/bin/python worker/gen/apps.py` (GEN_DB to override the scratch copy).
Writes gen/out/<template>/apps.json.
"""
import base64
import hashlib
import os

from _odoo import OUT, env, write_json
from odoo.tools import file_open


def main():
    with env() as e:
        charts = [
            {'code': code, 'name': t['name'], 'country_id': t['country_id'] or False, 'module': t['module']}
            for code, t in e['account.chart.template']._get_chart_template_mapping().items()
        ]
        modules, icons = {}, {}
        # the modules update_list creates on the site (the vendored OCA modules on disk, B6: gen/module_list.py `new`),
        # so Apps can show them after Update Apps List; rolled back with the rest
        e['ir.module.module'].update_list()
        for m in e['ir.module.module'].search([]):
            image = m.icon_image
            content = bytes(image.content) if image else b''
            sha = hashlib.sha256(content).hexdigest() if content else ''
            if content:
                icons[sha] = base64.b64encode(content).decode()
            modules[m.name] = {
                'description_html': str(m.description_html or ''),
                'icon_flag': m.icon_flag or '',
                'icon': sha,
                'installed_version': m.installed_version or '',
            }
    ratings = {}
    for threshold in (0, 1, 3, 5):
        with file_open(f'rating/static/src/img/rating_{threshold}.png', 'rb', filter_ext=('.png',)) as f:
            ratings[str(threshold)] = base64.b64encode(f.read()).decode()
    write_json(os.path.join(OUT, 'apps.json'), {'charts': charts, 'icons': icons, 'modules': modules, 'rating_images': ratings})


if __name__ == '__main__':
    main()
