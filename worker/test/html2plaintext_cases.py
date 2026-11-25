# The expectations of src/mail/html2plaintext.test.ts: odoo.tools.mail.html2plaintext of the html below (the stored
# calendar descriptions and the web editor's shapes), run from the repository root:
#   .venv/bin/python worker/test/html2plaintext_cases.py > worker/test/html2plaintext_cases.json
import sys, json
sys.path.insert(0, 'odoo')
from odoo.tools.mail import html2plaintext, html_sanitize

CASES = [
    '<div><strong>Organized by</strong><br>Mitchell Admin<br><a href="mailto:admin@example.com">admin@example.com</a><br><a href="tel:+1%20555-555-5555">+1 555-555-5555</a><br><br><strong>Contact Details</strong><br>Marc Demo<br><a href="mailto:mark.brown23@example.com">mark.brown23@example.com</a><br><a href="tel:(441)-695-2334">(441)-695-2334</a></div>',
    '<div><p>Agenda: budget, plans; Q&amp;A</p><p>Bring <strong>numbers</strong> and <a href="https://example.com/sheet">the sheet</a>.</p><br><strong>Organized by</strong><br>Mitchell Admin<br><a href="mailto:admin@example.com">admin@example.com</a><br><a href="tel:+1%20555-555-5555">+1 555-555-5555</a></div>',
    '<p>Hello</p>',
    '<p>a</p><p>b</p><p></p><p>c</p>',
    'plain text with &lt;angle&gt; &amp; ampersand',
    '<p>x <em>emph</em> <b>bold</b> <i>it</i></p><h1>Title</h1><h2>Sub</h2><h3>Small</h3>',
    '<ul><li>one</li><li>two <a href="https://a.example/x?y=1&amp;z=2">link</a></li></ul>',
    '<p><img src="/web/image/12/photo.png?unique=1" alt="x"> and <img src="data:image/png;base64,AAAA"> <img src="https://x.example/pic"></p>',
    '<p><a href="https://x.example"><strong>bold link</strong> tail</a> after</p>',
    '<p>nbsp:&nbsp;here&nbsp;&nbsp;two</p>',
    '<table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table>',
    '<div>line1<br/>line2<br />line3</div><div>  spaced   out  </div>',
    '<p>Hello</p><p><br></p><p><br></p><p>World</p>',
    '<p>Ünïcödé — “quotes” and emoji 😀</p>',
    '<p><a href="">empty href</a> <a>no href</a></p>',
    '<div><p>Agenda:</p><ul><li>budget</li><li>plans</li></ul></div>',
]
out = []
for html in CASES:
    clean = html_sanitize(html)
    out.append([clean, html2plaintext(clean)])
print(json.dumps(out, ensure_ascii=False, indent=0))
