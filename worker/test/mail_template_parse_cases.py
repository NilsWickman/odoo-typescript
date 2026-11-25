"""The expectations of src/xml/parse_html.test.ts: `lxml.html.fragment_fromstring(body, create_parent='div')`, as Odoo
parses a mail template (mail_render_mixin.py:315, :409), of every mail.template body_html of the database, in both
serializations Odoo has stored them in: the field's own `html_sanitize` with output_method 'xml' (before Odoo
9710d237f, 2026-09-18) and 'html' (after it). Each case: [xmlid, lang, method, body, tree]; a tree node is
[tag, [[attribute, value], ...], text, [children], tail], a comment ["<!--", text, tail]. Run from the repository root:
  GEN_TEMPLATE=poc_erp GEN_DB=<copy of poc_erp> .venv/bin/python worker/test/mail_template_parse_cases.py
writes worker/test/mail_template_parse_cases.json.
"""
import json, os, sys
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'gen'))
import _odoo  # noqa: E402


def canon(el):
    from lxml import etree
    if el.tag is etree.Comment:
        return ['<!--', el.text or '', el.tail or '']
    return [el.tag, [list(a) for a in el.attrib.items()], el.text or '', [canon(c) for c in el], el.tail or '']


def main():
    from lxml import html
    from odoo.tools.mail import html_sanitize
    cases, seen = [], set()
    with _odoo.env() as env:
        field = env['mail.template']._fields['body_html']
        opts = dict(sanitize_tags=field.sanitize_tags, sanitize_attributes=field.sanitize_attributes,
                    sanitize_style=field.sanitize_style, sanitize_form=field.sanitize_form,
                    sanitize_conditional_comments=field.sanitize_conditional_comments, strip_style=field.strip_style,
                    strip_classes=field.strip_classes)
        env.cr.execute("SELECT t.id, d.module || '.' || d.name, t.body_html FROM mail_template t "
                       "LEFT JOIN ir_model_data d ON d.model = 'mail.template' AND d.res_id = t.id "
                       "WHERE t.body_html IS NOT NULL ORDER BY t.id")
        for _id, xmlid, values in env.cr.fetchall():
            for lang, value in sorted(values.items()):
                for method in ('xml', 'html'):
                    body = html_sanitize(value, output_method=method, **opts)
                    if not body or body in seen:
                        continue
                    seen.add(body)
                    cases.append([xmlid, lang, method, str(body), canon(html.fragment_fromstring(str(body), create_parent='div'))])
    path = os.path.join(_odoo.ROOT, 'worker', 'test', 'mail_template_parse_cases.json')
    with open(path, 'w', encoding='utf-8') as f:
        f.write('[\n' + ',\n'.join(json.dumps(c, ensure_ascii=False) for c in cases) + '\n]\n')
    print(f'{len(cases)} cases ({sum(c[2] == "xml" for c in cases)} xml, {sum(c[2] == "html" for c in cases)} html) -> {path}')


if __name__ == '__main__':
    main()
