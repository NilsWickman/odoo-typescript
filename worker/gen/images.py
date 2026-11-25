"""Compile sizes of Odoo's fixed placeholder assets using its own image_process.

These are source assets, not database images or recorded HTTP responses (O4).
Runtime uploaded images still require the image-processing backend.
"""
import base64
import hashlib
import os
import _odoo
from odoo.tools.image import image_process

paths = [f'odoo/addons/base/static/img/{name}.png' for name in (
    'avatar_grey', 'avatar_placeholder_company', 'avatar_placeholder_delivery',
    'avatar_placeholder_invoice', 'avatar_placeholder_other')]
paths.append('addons/web/static/img/placeholder.png')
variants = {}
for path in paths:
    with open(os.path.join(_odoo.ROOT, 'odoo', path), 'rb') as source_file:
        source = source_file.read()
    checksum = hashlib.sha256(source).hexdigest()
    for size in (16, 32, 64, 128, 256, 512, 1024, 1920):
        result = image_process(source, size=(size, size))
        if result != source:
            variants[f'{checksum}:{size}:{size}'] = {
                'source': path, 'data': base64.b64encode(result).decode('ascii'),
            }
print(_odoo.write_json(os.path.join(_odoo.OUT, 'images.json'), variants))
