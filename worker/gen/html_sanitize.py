"""html_sanitize.py -> gen/out/html_sanitize.json: what the `sanitize='email_outgoing'` shortcut of `fields.Html` resolves
to in this Odoo commit (odoo/orm/fields_textual.py `Html._get_attrs`, :620-640), for src/orm/html_output.ts.

The shortcut is the only way a field of the registry gets `sanitize_tags=False, sanitize_attributes=False`, and it
fixes the field's `sanitize_output_method`: 'xml' up to Odoo 9710d237f (2026-09-18, "[FIX] orm: parse html field as
html (not xml)"), 'html' after it. The port serialises those fields (orm/write_values.ts) and the composer's body
(mail/composer.ts) with it. Every other Html field keeps the class default ('html').

The generator checks that rule on every Html field of the GEN_DB registry (`field.sanitize_output_method` against
the shortcut's when both options are off, the class default otherwise) and fails instead of writing when one field
breaks it: the port would serialise that field wrongly.

Run: GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/gen/html_sanitize.py
Writes gen/out/html_sanitize.json (GEN_OUT: another directory), shared by every template: it depends on the Odoo
source, not on a database (the database only provides the registry the rule is checked on).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _odoo  # noqa: E402

KEYS = ('sanitize', 'sanitize_tags', 'sanitize_attributes', 'sanitize_style', 'sanitize_form',
        'sanitize_conditional_comments', 'sanitize_output_method', 'strip_style', 'strip_classes')


def main():
    from odoo import fields
    with _odoo.env() as env:
        # the shortcut as the class resolves it for a field declared with it (fields_textual.py:627-635)
        probe = fields.Html(sanitize='email_outgoing')
        attrs = probe._get_attrs(type(env['res.partner']), 'x_html_sanitize_probe')
        outgoing = {k: attrs.get(k, getattr(fields.Html, k)) for k in KEYS}
        default = {k: getattr(fields.Html, k) for k in KEYS}
        checked, broken = 0, []
        for name in sorted(env.registry.models):
            for fname, field in env[name]._fields.items():
                if field.type != 'html':
                    continue
                checked += 1
                want = (outgoing if not field.sanitize_tags and not field.sanitize_attributes else default)['sanitize_output_method']
                if field.sanitize_output_method != want:
                    broken.append(f'{name}.{fname}: {field.sanitize_output_method}, the rule gives {want}')
        if broken:
            raise SystemExit('html_sanitize.py: Html fields outside the email_outgoing rule:\n  ' + '\n  '.join(broken))
    out = os.environ.get('GEN_OUT') or os.path.join(_odoo.ROOT, 'worker', 'gen', 'out')
    _odoo.write_json(os.path.join(out, 'html_sanitize.json'), {'email_outgoing': outgoing, 'default': default})
    print(f"html_sanitize.json: email_outgoing output method {outgoing['sanitize_output_method']!r}, "
          f"{checked} Html fields of {_odoo.DB} follow the rule")


if __name__ == '__main__':
    main()
