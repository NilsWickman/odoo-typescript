"""Cases for src/modules/relaxng.ts: XML data files and lxml's verdict on them with Odoo's import_xml.rng, as
convert_xml_import (odoo/odoo/tools/convert.py:792-797) gives it (the AssertionError's message, or null when valid).

  ../.venv/bin/python test/relaxng_cases.py            -> test/relaxng_cases.json (small: hand cases and mutations
                                                         of Odoo's data files under 700 bytes; committed, read by the test)
  ../.venv/bin/python test/relaxng_cases.py --all OUT  -> OUT (every data and demo file of every addon's manifest,
                                                         each as it is and with mutations; for a one-off check)

The mutations are seeded, so the files are the same on every run.
"""
import ast, json, pathlib, random, sys
from lxml import etree

ROOT = pathlib.Path(__file__).resolve().parents[2]
RNG = etree.RelaxNG(etree.parse(str(ROOT / "odoo/odoo/import_xml.rng")))


def verdict(text):
    doc = etree.fromstring(text.encode()).getroottree()
    try:
        RNG.assert_(doc)
        return None
    except AssertionError as e:
        return str(e)


HAND = [
    '<odoo><bogus/></odoo>', '<odoo><record model="a"/><bogus/></odoo>', '<odoo>\n<data>\n<record model="a"/>\n<bogus/></data></odoo>', '<bogus/>',
    '<odoo foo="1"><record model="a"/></odoo>', '<odoo b="1" a="2"><record model="a"/></odoo>', '<odoo b="1" a="2"><record/></odoo>',
    '<odoo>\n\nhello\nworld\n<record/></odoo>', '<odoo\n>\n<!-- a\n\nb -->x\n<bogus/></odoo>', '<odoo\n a="1"\n>\n<record model="a"/></odoo>',
    '<odoo>\n<bogus\n a="1"\n/></odoo>', '<odoo xmlns:t="u"><t:x/></odoo>', '<odoo xmlns:t="u"><record model="a" t:y="1"/></odoo>',
    '<odoo xmlns:t="u"><record model="a" xmlns:q="w"/></odoo>', '<odoo t:a="1" xmlns:t="u"><record model="a"/></odoo>', '<odoo xmlns="u"/>',
    '<t:odoo xmlns:t="u"/>', '<odoo><![CDATA[ x ]]><bogus/></odoo>', '<odoo>\n<![CDATA[\n]]><bogus/></odoo>', '<odoo>&#32;<bogus/></odoo>',
    '<odoo/>', '<data/>', '<openerp a="1"/>', '<odoo>  </odoo>', '<odoo>text</odoo>',
    '<odoo uid="1" context="x" noupdate="1" auto_sequence="1"><record model="a"/></odoo>',
    '<odoo><function model="a" name="b"><value eval="1"/><function model="c" name="d"/></function></odoo>',
    '<odoo><function model="a" name="b" eval="1"><value eval="1"/></function></odoo>', '<odoo><function model="a" name="b" eval="1"/></odoo>',
    '<odoo><function model="a"/></odoo>', '<odoo><function model="a" name="b"><value/></function></odoo>',
    '<odoo><function model="a" name="b"><value type="int" file="x"/></function></odoo>', '<odoo><function model="a" name="b"><value search="x" eval="y"/></function></odoo>',
    '<odoo><menuitem id="a" parent="b" action="c"><menuitem id="d"/></menuitem></odoo>', '<odoo><menuitem id="a" web_icon="x" action="c"><menuitem id="d" action="e"/></menuitem></odoo>',
    '<odoo><menuitem id="a" parent="b"><menuitem id="d"><menuitem id="e" action="f"/></menuitem></menuitem></odoo>', '<odoo><menuitem name="x"/></odoo>',
    '<odoo><menuitem id="a" sequence=""/></odoo>', '<odoo><menuitem id="a" sequence="+5"/></odoo>', '<odoo><menuitem id="a" sequence=" 5 "/></odoo>',
    '<odoo><menuitem id="a" sequence="5.0"/></odoo>', '<odoo><menuitem id="a" parent="b" web_icon="c"/></odoo>',
    '<odoo><delete model="a" id="b" search="c"/></odoo>', '<odoo><delete model="a" id="b"/></odoo>', '<odoo><delete model="a"/></odoo>', '<odoo><delete id="a"/></odoo>',
    '<odoo><template id="t" primary="True"/></odoo>', '<odoo><template id="t" inherit_id="x" primary="True"/></odoo>', '<odoo><template id="t" inherit_id="x" primary="False"/></odoo>',
    '<odoo><template id="t" inherit_id="x" primary=" True "/></odoo>', '<odoo><template id="t" foo="1"/></odoo>', '<odoo><template id="t" data-thumb="x"><div a="b">t<span/></div></template></odoo>',
    '<odoo><asset id="a" name="b"><path>x</path><bundle>y</bundle></asset></odoo>', '<odoo><asset id="a" name="b"><bundle directive="d">y</bundle><field name="f">1</field><path>x</path></asset></odoo>',
    '<odoo><asset id="a" name="b"><path>x</path></asset></odoo>', '<odoo><asset id="a" name="b"><path>x</path><bundle>y</bundle><path>z</path></asset></odoo>',
    '<odoo><record model="a" forcecreate="1"/></odoo>', '<odoo><record model="a" id="b" forcecreate="1"/></odoo>', '<odoo><record id="a"/></odoo>',
    '<odoo><record model="a">text</record></odoo>', '<odoo><record model="a"><!-- c --></record></odoo>', '<odoo><record model="a"><bogus/></record></odoo>',
    '<odoo><record model="a"><field/></record></odoo>', '<odoo><record model="a"><field name="b" eval="1">t</field></record></odoo>',
    '<odoo><record model="a"><field name="b" eval="1" model="m"/></record></odoo>', '<odoo><record model="a"><field name="b" search="[]" model="m" use="id"/></record></odoo>',
    '<odoo><record model="a"><field name="b" ref="y"> </field></record></odoo>', '<odoo><record model="a"><field name="b" ref="y" eval="z"/></record></odoo>',
    '<odoo><record model="a"><field name="b" type="char" file="y"/></record></odoo>', '<odoo><record model="a"><field name="b" type="file" file="x">t</field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="char"></field></record></odoo>', '<odoo><record model="a"><field name="b" type="base64">QQ==</field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="list"><value>1</value></field></record></odoo>', '<odoo><record model="a"><field name="b" type="list"></field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="tuple"><value eval="1"/><value search="[]" model="m" use="id"/></field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="xml">text only</field></record></odoo>', '<odoo><record model="a"><field name="b" type="html"><p a="1">t</p></field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="xml"><p/>tail<q xmlns:z="u" z:k="1"><z:r/></q></field></record></odoo>',
    '<odoo><record model="a"><field name="b"><record model="c"/></field></record></odoo>', '<odoo><record model="a"><field name="b">  <record model="c"/> </field></record></odoo>',
    '<odoo><record model="a"><field name="b"><record model="c"/>text</field></record></odoo>', '<odoo><record model="a"><field name="b">t<b/></field></record></odoo>',
    '<odoo><record model="a"><field name="b"><record model="c"><field name="d"><record id="e"/></field></record></field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="foo">x</field></record></odoo>', '<odoo><record model="a"><field name="b" type="int">1<!--c-->2</field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="int">1<!--c--></field></record></odoo>', '<odoo><record model="a"><field name="b" type="int"><!--c-->1</field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="int"><![CDATA[5]]></field></record></odoo>', '<odoo><record model="a"><field name="b" type="int">None</field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="int"> None </field></record></odoo>', '<odoo><record model="a"><field name="b" type="int"></field></record></odoo>',
    '<odoo><record model="a"><field name="b" type="float"></field></record></odoo>',
]
for v in ["1", " 12 ", "+5", "-0", "007", "1.0", "1e3", "2147483647", "2147483648", "-2147483648", "-2147483649", "99999999999", "x", "", " ", "1 2", "\n3\n", "١"]:
    HAND.append(f'<odoo><record model="a"><field name="b" type="int">{v}</field></record></odoo>')
for v in ["1", " 1.5e3 ", "INF", "-INF", "+INF", "inf", "NaN", " NaN ", "-NaN", ".5", "5.", "1E+2", "1e", "1e+", "e5", ".", "-", "+1", "-.5e-3", "1.2.3", "0x1", "1e400", "1 e3", "Infinity"]:
    HAND.append(f'<odoo><record model="a"><field name="b" type="float">{v}</field></record></odoo>')


def data_files():
    for addons in (ROOT / "odoo/addons", ROOT / "odoo/odoo/addons"):
        for man in sorted(addons.glob("*/__manifest__.py")):
            m = ast.literal_eval(man.read_text())
            for f in m.get("data", []) + m.get("demo", []):
                p = man.parent / f
                if f.endswith(".xml") and p.is_file():
                    yield p


def mutations(text, rnd, n):
    """Seeded mutations of a data file's tree, serialized by lxml (both parsers then read the same bytes)."""
    out = []
    for _ in range(n):
        root = etree.fromstring(text.encode())
        els = list(root.iter(etree.Element))
        el = rnd.choice(els)
        kind = rnd.randrange(9)
        if kind == 0:
            el.insert(rnd.randrange(len(el) + 1), etree.Element("bogus"))
        elif kind == 1 and el.attrib:
            del el.attrib[rnd.choice(list(el.attrib))]
        elif kind == 2:
            el.set("foo", "1")
        elif kind == 3:
            if len(el): el[rnd.randrange(len(el))].tail = "x"
            else: el.text = (el.text or "") + "x"
        elif kind == 4 and el is not root:
            el.tag = rnd.choice(["record", "field", "value", "menuitem", "data", "template", "function"])
        elif kind == 5:
            el.set("type", rnd.choice(["int", "float", "list", "xml", "char", "file", "html"]))
        elif kind == 6:
            el.text = rnd.choice(["12", "1.5", "None", "abc", "", " "])
        elif kind == 7 and el is not root and el.getparent() is not None:
            el.getparent().remove(el)
        elif kind == 8:
            el.set(rnd.choice(["id", "model", "name", "eval", "ref", "parent", "action", "sequence", "search"]), "x")
        else:
            continue
        out.append(etree.tostring(root, encoding="unicode"))
    return out


def main():
    rnd = random.Random(20261105)
    cases = [{"xml": x, "expected": verdict(x)} for x in HAND]
    big = len(sys.argv) > 2 and sys.argv[1] == "--all"
    for p in data_files():
        raw = p.read_bytes()
        if not big and len(raw) > 700:
            continue
        try:
            text = etree.tostring(etree.fromstring(raw), encoding="unicode")
        except etree.XMLSyntaxError:
            continue
        for x in [text] + mutations(text, rnd, 12 if big else 2):
            cases.append({"xml": x, "expected": verdict(x), "source": str(p.relative_to(ROOT))})
    dst = pathlib.Path(sys.argv[2]) if big else pathlib.Path(__file__).with_name("relaxng_cases.json")
    with open(dst, "w") as f:
        if big:
            for c in cases: f.write(json.dumps(c, sort_keys=True) + "\n")
        else:
            json.dump(cases, f, indent=0, sort_keys=True); f.write("\n")
    print(f"{dst}: {len(cases)} cases, {sum(c['expected'] is not None for c in cases)} invalid")


main()
