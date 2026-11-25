import { strict as assert } from "node:assert";
import { test } from "node:test";
import { htmlSanitize } from "./html_sanitize";

const DEFAULT = { sanitizeTags: true, sanitizeAttributes: true, sanitizeStyle: false, sanitizeForm: true, stripStyle: false, stripClasses: false };

/** Expected outputs of odoo.tools.mail.html_sanitize (lxml 5.2.1) with the Html field defaults. */
const CASES: [string, string][] = [
[
"  a  ",
"<p>a  </p>"
],
[
"a\n",
"<p>a\n</p>"
],
[
"\nb",
"<p>b</p>"
],
[
"<p>a</p>b",
"<p>a</p>b"
],
[
"a<p>b</p>",
"<p>a</p><p>b</p>"
],
[
"<b>x</b>",
"<b>x</b>"
],
[
"hello <b>x</b>",
"<p>hello <b>x</b></p>"
],
[
"<p>a</p>  ",
"<p>a</p>  "
],
[
"  <p>a</p>",
"<p>a</p>"
],
[
"<div>a</div><div>b</div>",
"<div>a</div><div>b</div>"
],
[
"<p>a</p>\n<p>b</p>",
"<p>a</p>\n<p>b</p>"
],
[
"<br>",
"<br>"
],
[
"x<br/>y",
"<p>x<br>y</p>"
],
[
"<p class=\"c\" style=\"color:red\" data-x=\"1\" id=\"i\">a</p>",
"<p class=\"c\" style=\"color:red\" data-x=\"1\" id=\"i\">a</p>"
],
[
"<a href=\"http://x\" target=\"_blank\" rel=\"nofollow\">l</a>",
"<a href=\"http://x\" target=\"_blank\" rel=\"nofollow\">l</a>"
],
[
"<p>a & b</p>",
"<p>a &amp; b</p>"
],
[
"<p>&quot;q&quot; &#39; &lt;</p>",
"<p>\"q\" ' &lt;</p>"
],
[
"<p title=\"a &amp; b &quot;\">x</p>",
"<p title='a &amp; b \"'>x</p>"
],
[
"é",
"<p>é</p>"
],
[
"<h1>T</h1><ul><li>a<li>b</ul>",
"<h1>T</h1><ul><li>a</li><li>b</li></ul>"
],
[
"<img src=\"data:image/png;base64,AAA\">",
"<img src=\"data:image/png;base64,AAA\">"
],
[
"<p>a</p><script>alert(1)</script>",
"<p>a</p>"
],
[
"<font color=\"red\">x</font>",
"<font color=\"red\">x</font>"
],
[
"<span style=\"font-weight: bold\">x</span>",
"<span style=\"font-weight: bold\">x</span>"
],
[
"<em>a</em><strong>b</strong>",
"<span><em>a</em><strong>b</strong></span>"
],
[
"<p><br></p>",
"<p><br></p>"
],
[
"",
""
],
[
" ",
""
],
[
"<p></p>",
"<p></p>"
],
[
"<table><tbody><tr><td>1</td></tr></tbody></table>",
"<table><tbody><tr><td>1</td></tr></tbody></table>"
],
[
"<p>a b</p>",
"<p>a&nbsp;b</p>"
],
[
"<blockquote>q</blockquote>",
"<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q</blockquote>"
],
[
"<p>x</p><p>y</p><p>z</p>",
"<p>x</p><p>y</p><p>z</p>"
],
[
"<div><b>x</b></div>",
"<div><b>x</b></div>"
],
[
"<p title=\"é<>&\">x</p>",
"<p title=\"é&lt;&gt;&amp;\">x</p>"
],
[
"<input checked>",
"<div></div>"
],
[
"<option selected>a</option>",
"<option selected>a</option>"
],
[
"<a href=\"http://x/a b\">l</a>",
"<a href=\"http://x/a%20b\">l</a>"
],
[
"<a href=\"http://x/é\">l</a>",
"<a href=\"http://x/%C3%A9\">l</a>"
],
[
"<a href=\"javascript:alert(1)\">x</a>",
"<a href=\"\">x</a>"
],
[
"<a href=\"#top\">x</a>",
"<a href=\"#top\">x</a>"
],
[
"<img src=\"x.png\" alt=\"a\">",
"<img src=\"x.png\" alt=\"a\">"
],
[
"<foo>x</foo>",
"<div>x</div>"
],
[
"<P>A</P>",
"<p>A</p>"
],
[
"<ul>\n<li>a</li>\n</ul>",
"<ul>\n<li>a</li>\n</ul>"
],
[
"<div>\n<p>a</p>\n</div>",
"<div>\n<p>a</p>\n</div>"
],
[
"<p>a<b>b</p>",
"<p>a<b>b</b></p>"
],
[
"<p>a</div>",
"<p>a</p>"
],
[
"</p>x",
"<p>x</p>"
],
[
"<p>x</p></p>",
"<p>x</p>"
],
[
"<b><p>x</p></b>",
"<b></b><p>x</p>"
],
[
"<span><p>x</p></span>",
"<span><p>x</p></span>"
],
[
"<p>a<ul><li>b</li></ul>",
"<p>a</p><ul><li>b</li></ul>"
],
[
"<p>a<div>b</div>",
"<p>a</p><div>b</div>"
],
[
"<p>a<table><tr><td>x</td></tr></table>",
"<p>a</p><table><tr><td>x</td></tr></table>"
],
[
"<p>a<h1>b</h1>",
"<p>a</p><h1>b</h1>"
],
[
"<p>a<blockquote>b</blockquote>",
"<p>a</p><blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">b</blockquote>"
],
[
"<p>a<pre>b</pre>",
"<p>a</p><pre>b</pre>"
],
[
"<p>a<hr>b",
"<p>a</p><hr>b"
],
[
"<p>a<span>b</span>c</p>",
"<p>a<span>b</span>c</p>"
],
[
"<p>a<img src=\"x\">b</p>",
"<p>a<img src=\"x\">b</p>"
],
[
"<table><tr><td>x</td></tr></table>",
"<table><tr><td>x</td></tr></table>"
],
[
"<p>1 &gt; 0 &amp;&amp; x</p>",
"<p>1 &gt; 0 &amp;&amp; x</p>"
],
[
"<p>&eacute; &copy; &euro;</p>",
"<p>é © €</p>"
],
[
"<p>&apos;</p>",
"<p>'</p>"
],
[
"<p>a&nbsp;</p>",
"<p>a&nbsp;</p>"
],
[
"<a href=\"mailto:a@b.c\">m</a>",
"<a href=\"mailto:a@b.c\">m</a>"
],
[
"<p style=\"background:url(x)\">a</p>",
"<p style=\"background:url(x)\">a</p>"
],
[
"<td>x</td>",
"<td>x</td>"
],
[
"<li>x</li>",
"<li>x</li>"
],
[
"<p a=b c>x</p>",
"<p>x</p>"
],
[
"<p class=x>y</p>",
"<p class=\"x\">y</p>"
],
[
"<p id=\"a\" class=\"b\">c</p>",
"<p id=\"a\" class=\"b\">c</p>"
],
[
"<div><p>a</p>b</div>",
"<div><p>a</p>b</div>"
],
[
"x\n<p>y</p>",
"<p>x\n</p><p>y</p>"
],
[
"<br/>a",
"<span><br>a</span>"
],
[
"<p>a</p><br>",
"<p>a</p><br>"
],
[
"<h2>Title</h2>\n<p>Body</p>",
"<h2>Title</h2>\n<p>Body</p>"
],
[
"<a href=\"x?a=1&amp;b=2\">l</a>",
"<a href=\"x?a=1&amp;b=2\">l</a>"
],
[
"<a href=\"x\" title=\"a&quot;b\">l</a>",
"<a href=\"x\" title='a\"b'>l</a>"
],
[
"<p title=\"it&#39;s\">x</p>",
"<p title=\"it's\">x</p>"
],
[
"<p title=\"a&quot;b&#39;c\">x</p>",
"<p title=\"a&quot;b'c\">x</p>"
],
[
"<img src=\"data:image/svg+xml;base64,AA\">",
"<img src=\"\">"
],
[
"<a href=\" javascript:x\">a</a>",
"<a href=\"\">a</a>"
],
[
"<a href=\"data:text/html,x\">a</a>",
"<a href=\"\">a</a>"
],
[
"<p>a</p>\n",
"<p>a</p>\n"
],
[
"\n<p>a</p>",
"<p>a</p>"
],
[
"<p>a</p>\n\n<p>b</p>",
"<p>a</p>\n\n<p>b</p>"
],
[
"<ul><li>a</li> <li>b</li></ul>",
"<ul><li>a</li> <li>b</li></ul>"
],
[
"<table> <tr> <td>x</td> </tr> </table>",
"<table> <tr> <td>x</td> </tr> </table>"
],
[
"<p>  a  </p>",
"<p>  a  </p>"
],
[
"text with <a href=\"http://x\">link</a> end",
"<p>text with <a href=\"http://x\">link</a> end</p>"
],
[
"<span>a</span> b",
"<span><span>a</span> b</span>"
],
[
"a <span>b</span>",
"<p>a <span>b</span></p>"
],
[
"<b>a</b>\n",
"<b>a</b>\n"
],
[
"<i>x",
"<i>x</i>"
],
[
"<p>x",
"<p>x</p>"
],
[
"<div>x",
"<div>x</div>"
],
[
"<ul><li>a<li>b</ul>",
"<ul><li>a</li><li>b</li></ul>"
],
[
"<p>a\n<br>\nb</p>",
"<p>a\n<br>\nb</p>"
],
[
"<h3>x</h3>y",
"<h3>x</h3>y"
],
[
"<p dir=\"rtl\" align=\"center\">x</p>",
"<p dir=\"rtl\" align=\"center\">x</p>"
],
[
"<p onclick=\"x\" class=\"c\">y</p>",
"<p class=\"c\">y</p>"
],
[
"<p data-oe-model=\"m\">x</p>",
"<p data-oe-model=\"m\">x</p>"
],
[
"<span class=\"fa fa-x\"></span>",
"<span class=\"fa fa-x\"></span>"
],
[
"<p><span style=\"color: rgb(1,2,3);\">x</span></p>",
"<p><span style=\"color: rgb(1,2,3);\">x</span></p>"
],
[
"<p>1<sup>2</sup></p>",
"<p>1<sup>2</sup></p>"
],
[
"<code>a&lt;b</code>",
"<code>a&lt;b</code>"
],
[
"<pre>a\n  b</pre>",
"<pre>a\n  b</pre>"
],
[
"<p>tab\there</p>",
"<p>tab\there</p>"
],
[
"<p>a\r\nb</p>",
"<p>a\r\nb</p>"
],
[
"<p>Your payment has been authorized.</p>",
"<p>Your payment has been authorized.</p>"
],
[
"Your payment has been authorized.",
"<p>Your payment has been authorized.</p>"
],
[
"<p><a href=\"/odoo\">x</a></p>",
"<p><a href=\"/odoo\">x</a></p>"
],
[
"<ol start=\"3\"><li>a</li></ol>",
"<ol start=\"3\"><li>a</li></ol>"
],
[
"<div class=\"o_x\"><p>a</p></div>",
"<div class=\"o_x\"><p>a</p></div>"
],
[
"<p><strong>x</strong> and <em>y</em></p>",
"<p><strong>x</strong> and <em>y</em></p>"
],
[
"<h1 style=\"text-align:center\">T</h1>",
"<h1 style=\"text-align:center\">T</h1>"
],
[
"<p>a</p><!-- c -->",
"<p>a</p><!-- c -->"
],
[
"<p>&lt;script&gt;</p>",
"<p>&lt;script&gt;</p>"
],
[
"<span>a<br>b</span>",
"<span>a<br>b</span>"
],
[
"<p>– dash</p>",
"<p>– dash</p>"
]
];

/** Inputs whose libxml2 repair is not reproduced: refused, never stored raw. */
const REFUSED = ["<b><p>x</p></b>", "<foo>x</foo>", "<p>a</p><!-- c -->"];

/**
 * tag_quote (mail.py:178-288) and end tags of no open element, 2026-11-07: odoo.tools.mail.html_sanitize(src, silent=False,
 * **kw) of the pinned Odoo with kw = {}, {sanitize_style: True} and {sanitize_attributes: True, sanitize_style: True} (the message body's options).
 */
const QUOTE_CASES: [string, string, string, string][] = [
 [
  "<div><p>a<br/><br/><div>--<br/>Mitchell</div>\n</p>\n</div>",
  "<div data-o-mail-quote-container=\"1\"><p>a<br><br></p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">Mitchell</div>\n\n</div>",
  "<div data-o-mail-quote-container=\"1\"><p>a<br><br></p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">Mitchell</div>\n\n</div>",
  "<div><p>a<br><br></p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">Mitchell</div>\n\n</div>"
 ],
 [
  "<div>a</p>b</div>",
  "<div>ab</div>",
  "<div>ab</div>",
  "<div>ab</div>"
 ],
 [
  "<p>x<div>--<br/>sig</div></p>",
  "<div data-o-mail-quote-container=\"1\"><p>x</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">sig</div></div>",
  "<div data-o-mail-quote-container=\"1\"><p>x</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">sig</div></div>",
  "<p>x</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">sig</div>"
 ],
 [
  "<div>x</p></div>",
  "<div>x</div>",
  "<div>x</div>",
  "<div>x</div>"
 ],
 [
  "<p>a</p></p>",
  "<p>a</p>",
  "<p>a</p>",
  "<p>a</p>"
 ],
 [
  "<div>a</span>b</div>",
  "<div>ab</div>",
  "<div>ab</div>",
  "<div>ab</div>"
 ],
 [
  "<div>a</div></div>c",
  "<div>a</div>c",
  "<div>a</div>c",
  "<div>a</div>c"
 ],
 [
  "<p>a</b>c</p>",
  "<p>ac</p>",
  "<p>ac</p>",
  "<p>ac</p>"
 ],
 [
  "<div>x</li>y</div>",
  "<div>xy</div>",
  "<div>xy</div>",
  "<div>xy</div>"
 ],
 [
  "<span>x</p>y</span>",
  "<span>xy</span>",
  "<span>xy</span>",
  "<span>xy</span>"
 ],
 [
  "x</p>y",
  "<p>x</p>y",
  "<p>x</p>y",
  "<p>x</p>y"
 ],
 [
  "<div>a</p></div><p>b</p>",
  "<div>a</div><p>b</p>",
  "<div>a</div><p>b</p>",
  "<div>a</div><p>b</p>"
 ],
 [
  "<p>a</p>\n</p>\n<p>b</p>",
  "<p>a</p>\n\n<p>b</p>",
  "<p>a</p>\n\n<p>b</p>",
  "<p>a</p>\n\n<p>b</p>"
 ],
 [
  "<div>-- <br/>x</div>",
  "<div data-o-mail-quote=\"1\">-- <br data-o-mail-quote=\"1\">x</div>",
  "<div data-o-mail-quote=\"1\">-- <br data-o-mail-quote=\"1\">x</div>",
  "<div data-o-mail-quote=\"1\">-- <br data-o-mail-quote=\"1\">x</div>"
 ],
 [
  "<div>hello\n-- \nsig</div>",
  "<div>hello<span data-o-mail-quote=\"1\">\n-- \nsig</span></div>",
  "<div>hello<span data-o-mail-quote=\"1\">\n-- \nsig</span></div>",
  "<div>hello<span data-o-mail-quote=\"1\">\n-- \nsig</span></div>"
 ],
 [
  "<blockquote>q</blockquote><p>after</p>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q</blockquote><p>after</p>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q</blockquote><p>after</p>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q</blockquote><p>after</p>"
 ],
 [
  "<div><p>a</p><div>--<br/>s</div><p>b</p><p> </p></div>",
  "<div data-o-mail-quote-container=\"1\"><p>a</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div><p data-o-mail-quote=\"1\">b</p><p data-o-mail-quote=\"1\"> </p></div>",
  "<div data-o-mail-quote-container=\"1\"><p>a</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div><p data-o-mail-quote=\"1\">b</p><p data-o-mail-quote=\"1\"> </p></div>",
  "<div><p>a</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div><p data-o-mail-quote=\"1\">b</p><p data-o-mail-quote=\"1\"> </p></div>"
 ],
 [
  "<p>a\n> quoted\n> more</p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; quoted\n&gt; more</span></p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; quoted\n&gt; more</span></p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; quoted\n&gt; more</span></p>"
 ],
 [
  "<p>a\n> one</p><p>b\n> two\nc\n> three</p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; one</span></p><p>b<span data-o-mail-quote=\"1\">\n&gt; two</span>\nc<span data-o-mail-quote=\"1\">\n&gt; three</span></p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; one</span></p><p>b<span data-o-mail-quote=\"1\">\n&gt; two</span>\nc<span data-o-mail-quote=\"1\">\n&gt; three</span></p>",
  "<p>a<span data-o-mail-quote=\"1\">\n&gt; one</span></p><p>b<span data-o-mail-quote=\"1\">\n&gt; two</span>\nc<span data-o-mail-quote=\"1\">\n&gt; three</span></p>"
 ],
 [
  "<div class=\"gmail_quote\">q<p>r</p></div><p>s</p>",
  "<div class=\"gmail_quote\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\">q<p data-o-mail-quote=\"1\">r</p></div><p>s</p>",
  "<div class=\"gmail_quote\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\">q<p data-o-mail-quote=\"1\">r</p></div><p>s</p>",
  "<div class=\"gmail_quote\" data-o-mail-quote=\"1\">q<p data-o-mail-quote=\"1\">r</p></div><p>s</p>"
 ],
 [
  "<p>a</p><div class=\"gmail_extra\">e</div><p>after</p>",
  "<div data-o-mail-quote-container=\"1\"><p>a</p><div class=\"gmail_extra\" data-o-mail-quote=\"1\">e</div><p data-o-mail-quote=\"1\">after</p></div>",
  "<div data-o-mail-quote-container=\"1\"><p>a</p><div class=\"gmail_extra\" data-o-mail-quote=\"1\">e</div><p data-o-mail-quote=\"1\">after</p></div>",
  "<p>a</p><div class=\"gmail_extra\" data-o-mail-quote=\"1\">e</div><p data-o-mail-quote=\"1\">after</p>"
 ],
 [
  "<div id=\"Signature\">s<p>t</p></div>",
  "<div id=\"Signature\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\">s<p data-o-mail-quote=\"1\">t</p></div>",
  "<div id=\"Signature\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\">s<p data-o-mail-quote=\"1\">t</p></div>",
  "<div id=\"Signature\" data-o-mail-quote=\"1\">s<p data-o-mail-quote=\"1\">t</p></div>"
 ],
 [
  "<p>x</p><hr class=\"stopSpelling\"/><p>y</p><p>z</p>",
  "<p>x</p><hr class=\"stopSpelling\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">y</p><p data-o-mail-quote=\"1\">z</p>",
  "<p>x</p><hr class=\"stopSpelling\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">y</p><p data-o-mail-quote=\"1\">z</p>",
  "<p>x</p><hr class=\"stopSpelling\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">y</p><p data-o-mail-quote=\"1\">z</p>"
 ],
 [
  "<div><div>--<br/>s</div></div>",
  "<div data-o-mail-quote-container=\"1\"><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div></div>",
  "<div data-o-mail-quote-container=\"1\"><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div></div>",
  "<div><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\">s</div></div>"
 ],
 [
  "<blockquote>q<p>in</p></blockquote>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q<p>in</p></blockquote>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q<p>in</p></blockquote>",
  "<blockquote data-o-mail-quote-node=\"1\" data-o-mail-quote=\"1\">q<p>in</p></blockquote>"
 ],
 [
  "<p>a</div>",
  "<p>a</p>",
  "<p>a</p>",
  "<p>a</p>"
 ],
 [
  "<div>--\n<br/>x</div>",
  "<div data-o-mail-quote=\"1\">--\n<br data-o-mail-quote=\"1\">x</div>",
  "<div data-o-mail-quote=\"1\">--\n<br data-o-mail-quote=\"1\">x</div>",
  "<div data-o-mail-quote=\"1\">--\n<br data-o-mail-quote=\"1\">x</div>"
 ],
 [
  "<div>x\n--<br/>y</div>",
  "<div data-o-mail-quote=\"1\">x\n--<br data-o-mail-quote=\"1\">y</div>",
  "<div data-o-mail-quote=\"1\">x\n--<br data-o-mail-quote=\"1\">y</div>",
  "<div data-o-mail-quote=\"1\">x\n--<br data-o-mail-quote=\"1\">y</div>"
 ],
 [
  "<p>-- </p>",
  "<p>-- </p>",
  "<p>-- </p>",
  "<p>-- </p>"
 ],
 [
  "<div><b>--<br/></b><p></p></div>",
  "<div data-o-mail-quote-container=\"1\"><b data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"></b><p data-o-mail-quote=\"1\"></p></div>",
  "<div data-o-mail-quote-container=\"1\"><b data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"></b><p data-o-mail-quote=\"1\"></p></div>",
  "<div><b data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"></b><p data-o-mail-quote=\"1\"></p></div>"
 ],
 [
  "<p>a</p><div class=\"odoo_signature_wrapper\"><p>s</p><p>t</p></div><p></p>",
  "<p>a</p><div class=\"odoo_signature_wrapper\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">s</p><p data-o-mail-quote=\"1\">t</p></div><p data-o-mail-quote=\"1\"></p>",
  "<p>a</p><div class=\"odoo_signature_wrapper\" data-o-mail-quote-container=\"1\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">s</p><p data-o-mail-quote=\"1\">t</p></div><p data-o-mail-quote=\"1\"></p>",
  "<p>a</p><div class=\"odoo_signature_wrapper\" data-o-mail-quote=\"1\"><p data-o-mail-quote=\"1\">s</p><p data-o-mail-quote=\"1\">t</p></div><p data-o-mail-quote=\"1\"></p>"
 ],
 [
  "<div>\n--\nsig text\n</div>",
  "<div><span data-o-mail-quote=\"1\">\n--\nsig text\n</span></div>",
  "<div><span data-o-mail-quote=\"1\">\n--\nsig text\n</span></div>",
  "<div><span data-o-mail-quote=\"1\">\n--\nsig text\n</span></div>"
 ]
];

const FN_DEFAULT = { sanitizeTags: true, sanitizeAttributes: false, sanitizeStyle: false, sanitizeForm: true, stripStyle: false, stripClasses: false };

test("html_sanitize ports tag_quote and ignores end tags of no open element", () => {
  for (const [src, plain, style, attrs] of QUOTE_CASES) {
    assert.equal(htmlSanitize(src, FN_DEFAULT), plain, src);
    assert.equal(htmlSanitize(src, { ...FN_DEFAULT, sanitizeStyle: true }), style, src);
    assert.equal(htmlSanitize(src, { ...FN_DEFAULT, sanitizeAttributes: true, sanitizeStyle: true }), attrs, src);
  }
});

test("html_sanitize matches the reference on the supported subset", () => {
  for (const [src, expected] of CASES) {
    let got: string | null = null;
    try { got = htmlSanitize(src, DEFAULT); } catch { continue; }
    assert.equal(got, expected, src);
  }
});

/** Comments before the content (lxml 5.2.1, the Html field's defaults): outside <body>, dropped. */
const LEADING_COMMENTS: [string, string][] = [
  ["\n            <!-- TODO: better help message -->\n            <p class=\"o_view_nocontent_smiling_face\">Hi</p>\n  ", "<p class=\"o_view_nocontent_smiling_face\">Hi</p>\n  "],
  ["<!--a--><!--b--><p>x</p>", "<p>x</p>"],
  ["<!-- only -->", ""],
  ["<!---->", ""],
  ["  <!-- c -->text", "<p>text</p>"],
];

test("html_sanitize drops comments before the content and refuses the others", () => {
  for (const [src, expected] of LEADING_COMMENTS) assert.equal(htmlSanitize(src, DEFAULT), expected, src);
  // kept by lxml inside the content (`<p>a<!-- c -->b</p>`), and the unusual forms: refused
  for (const src of ["<p>a<!-- c -->b</p>", "<p>a</p><!-- c -->", "<!-- a -- b --><p>x</p>", "<!--x", "<!-->b"]) {
    assert.throws(() => htmlSanitize(src, DEFAULT), /not ported/, src);
  }
});

/** A qweb `<t>` with sanitize='email_outgoing' (no tag or attribute sanitizing, xml output), lxml 5.2.1: the cleaner
 *  keeps it. The first case is lunch's mail template lunch_order_mail_supplier as convert.py passes it. */
const QWEB_CASES: [string, string][] = [
  ["<t>\n<t t-set=\"lines\" t-value=\"ctx.get('lines', [])\"></t>\n<t t-set=\"order\" t-value=\"ctx.get('order', {})\"></t>\n<t t-set=\"currency\" t-value=\"user.env['res.currency'].browse(order.get('currency_id'))\"></t>\n<p>\nDear <t t-out=\"order.get('supplier_name', '')\">Laurie Poiret</t>,\n</p><p>\nHere is, today orders for <t t-out=\"order.get('company_name', '')\">LunchCompany</t>:\n</p>\n\n<t t-if=\"sites\">\n    <br>\n    <p>Location</p>\n    <p t-foreach=\"site\" t-as=\"site\">\n        <t t-out=\"site['name'] or ''\"></t> : <t t-out=\"site['address'] or ''\"></t>\n    </p>\n    <br>\n</t>\n\n<table>\n    <thead>\n        <tr style=\"background-color:rgb(233,232,233);\">\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Product</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Comments</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Person</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Site</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\" align=\"center\"><strong>Qty</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\" align=\"center\"><strong>Price</strong></th>\n        </tr>\n    </thead>\n    <tbody>\n        <tr t-foreach=\"lines\" t-as=\"line\">\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['product'] or ''\">Sushi salmon</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\">\n            <t t-if=\"line['toppings']\">\n                <t t-out=\"line['toppings'] or ''\">Soy sauce</t>\n            </t>\n            <t t-if=\"line['note']\">\n                <div style=\"color: rgb(173,181,189);\" t-out=\"line['note'] or ''\">With wasabi.</div>\n            </t>\n            </td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['username'] or ''\">lap</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['site'] or ''\">Office 1</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" align=\"right\" t-out=\"line['quantity'] or ''\">10</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" align=\"right\" t-out=\"format_amount(line['price'], currency) or ''\">$ 1.00</td>\n        </tr>\n        <tr>\n            <td></td>\n            <td></td>\n            <td></td>\n            <td></td>\n            <td style=\"width: 100%; font-size: 13px; border-top: 1px solid black;\"><strong>Total</strong></td>\n            <td style=\"width: 100%; font-size: 13px; border-top: 1px solid black;\" align=\"right\"><strong t-out=\"order.get('amount_total') and format_amount(order['amount_total'], currency) or ''\">$ 10.00</strong></td>\n        </tr>\n    </tbody>\n</table>\n\n<p>Do not hesitate to contact us if you have any questions.</p>\n        </t>", "<t>\n<t t-set=\"lines\" t-value=\"ctx.get('lines', [])\"/>\n<t t-set=\"order\" t-value=\"ctx.get('order', {})\"/>\n<t t-set=\"currency\" t-value=\"user.env['res.currency'].browse(order.get('currency_id'))\"/>\n<p>\nDear <t t-out=\"order.get('supplier_name', '')\">Laurie Poiret</t>,\n</p><p>\nHere is, today orders for <t t-out=\"order.get('company_name', '')\">LunchCompany</t>:\n</p>\n\n<t t-if=\"sites\">\n    <br/>\n    <p>Location</p>\n    <p t-foreach=\"site\" t-as=\"site\">\n        <t t-out=\"site['name'] or ''\"/> : <t t-out=\"site['address'] or ''\"/>\n    </p>\n    <br/>\n</t>\n\n<table>\n    <thead>\n        <tr style=\"background-color:rgb(233,232,233);\">\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Product</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Comments</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Person</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\"><strong>Site</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\" align=\"center\"><strong>Qty</strong></th>\n            <th style=\"width: 100%; min-width: 96px; font-size: 13px;\" align=\"center\"><strong>Price</strong></th>\n        </tr>\n    </thead>\n    <tbody>\n        <tr t-foreach=\"lines\" t-as=\"line\">\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['product'] or ''\">Sushi salmon</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\">\n            <t t-if=\"line['toppings']\">\n                <t t-out=\"line['toppings'] or ''\">Soy sauce</t>\n            </t>\n            <t t-if=\"line['note']\">\n                <div style=\"color: rgb(173,181,189);\" t-out=\"line['note'] or ''\">With wasabi.</div>\n            </t>\n            </td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['username'] or ''\">lap</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" t-out=\"line['site'] or ''\">Office 1</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" align=\"right\" t-out=\"line['quantity'] or ''\">10</td>\n            <td style=\"width: 100%; font-size: 13px;\" valign=\"top\" align=\"right\" t-out=\"format_amount(line['price'], currency) or ''\">$ 1.00</td>\n        </tr>\n        <tr>\n            <td/>\n            <td/>\n            <td/>\n            <td/>\n            <td style=\"width: 100%; font-size: 13px; border-top: 1px solid black;\"><strong>Total</strong></td>\n            <td style=\"width: 100%; font-size: 13px; border-top: 1px solid black;\" align=\"right\"><strong t-out=\"order.get('amount_total') and format_amount(order['amount_total'], currency) or ''\">$ 10.00</strong></td>\n        </tr>\n    </tbody>\n</table>\n\n<p>Do not hesitate to contact us if you have any questions.</p>\n        </t>"],
  ["<t t-out=\"x\"></t>", "<t t-out=\"x\"/>"],
  ["<t><p>a</p><t t-if=\"b\"><br/><p>c</p></t></t>", "<t><p>a</p><t t-if=\"b\"><br/><p>c</p></t></t>"],
  ["<table><tr><td><t t-if=\"x\"><div>y</div></t></td></tr></table>", "<table><tr><td><t t-if=\"x\"><div>y</div></t></td></tr></table>"],
  ["<p>Dear <t t-out=\"a\">L</t>,\n</p>", "<p>Dear <t t-out=\"a\">L</t>,\n</p>"],
  ["<table><tr t-foreach=\"l\" t-as=\"x\"><td t-out=\"x\">v</td></tr></table>", "<table><tr t-foreach=\"l\" t-as=\"x\"><td t-out=\"x\">v</td></tr></table>"]
];
const EMAIL_OUTGOING = { sanitizeTags: false, sanitizeAttributes: false, sanitizeStyle: false, sanitizeForm: true, stripStyle: false, stripClasses: false, xmlOutput: true };

test("html_sanitize keeps qweb <t> elements without tag sanitizing", () => {
  for (const [src, expected] of QWEB_CASES) assert.equal(htmlSanitize(src, EMAIL_OUTGOING), expected, src);
  // with the tags sanitized (the default Html field), an unknown tag still refuses
  assert.throws(() => htmlSanitize('<t t-out="x"></t>', DEFAULT), /not ported/);
});

test("html_sanitize refuses what it cannot clean exactly", () => {
  for (const src of REFUSED) assert.throws(() => htmlSanitize(src, DEFAULT), /not ported/, src);
});

/** Full documents (the email layouts' output, mail.mail body -> mail.message body): html_sanitize of lxml 5.2.1 (with
 *  odoo/_monkeypatches/lxml.py's ARIA attributes in safe_attrs, as in the server) with
 *  the function's defaults, sanitize_style, sanitize_attributes+style, and 'email_outgoing' (xml output). */
const DOC_CASES: [string, string, string, string, string][] = [
 [
  "\n<html lang=\"en_US\">\n<head>\n    <meta http-equiv=\"Content-Type\" content=\"text/html charset=UTF-8\"/>\n</head>\n<body style=\"font-family:Verdana, Arial,sans-serif; color: #454748;\">\n\n<div style=\"display: none; max-height: 0px; overflow: hidden; color:#fff\">x &#34;q&#34;</div>\n<div style=\"max-width: 900px; width: 100%;\">\n<p>a<br/>b</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"/><div>Mitchell</div></div>\n</div>\n</body></html>",
  "\n\n\n\n<div style=\"display: none; max-height: 0px; overflow: hidden; color:#fff\">x \"q\"</div>\n<div style=\"max-width: 900px; width: 100%;\" data-o-mail-quote-container=\"1\">\n<p>a<br>b</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"><div data-o-mail-quote=\"1\">Mitchell</div></div>\n</div>\n",
  "\n\n\n\n<div style=\"display:none; color:#fff\">x \"q\"</div>\n<div style=\"max-width:900px; width:100%\" data-o-mail-quote-container=\"1\">\n<p>a<br>b</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"><div data-o-mail-quote=\"1\">Mitchell</div></div>\n</div>\n",
  "\n\n\n\n<div style=\"display:none; color:#fff\">x \"q\"</div>\n<div style=\"max-width:900px; width:100%\">\n<p>a<br>b</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"><div data-o-mail-quote=\"1\">Mitchell</div></div>\n</div>\n",
  "\n\n    \n\n<body style=\"font-family:Verdana, Arial,sans-serif; color:#454748\">\n\n<div style=\"display:none; color:#fff\">x \"q\"</div>\n<div style=\"max-width:900px; width:100%\" data-o-mail-quote-container=\"1\">\n<p>a<br/>b</p><div data-o-mail-quote=\"1\">--<br data-o-mail-quote=\"1\"/><div data-o-mail-quote=\"1\">Mitchell</div></div>\n</div>\n</body>"
 ],
 [
  "<html><head><meta/></head><body><div style=\"display: none; max-height: 0px\">x</div><p>hej<br/></p></body></html>",
  "<div style=\"display: none; max-height: 0px\">x</div><p>hej<br></p>",
  "<div style=\"display:none\">x</div><p>hej<br></p>",
  "<div style=\"display:none\">x</div><p>hej<br></p>",
  "<body><div style=\"display:none\">x</div><p>hej<br/></p></body>"
 ],
 [
  "\n<html lang=\"en_US\">\n<head>\n    <meta http-equiv=\"Content-Type\" content=\"text/html charset=UTF-8\"/>\n</head>\n<body>\n<table role=\"presentation\" border=\"0\"><tr><td align=\"center\">a</td></tr>\n\n<tr><td>b</td></tr>\n</table>\n</body>\n</html>\n",
  "\n\n\n<table role=\"presentation\" border=\"0\"><tr><td align=\"center\">a</td></tr>\n\n<tr><td>b</td></tr>\n</table>\n\n",
  "\n\n\n<table role=\"presentation\" border=\"0\"><tr><td align=\"center\">a</td></tr>\n\n<tr><td>b</td></tr>\n</table>\n\n",
  "\n\n\n<table role=\"presentation\" border=\"0\"><tr><td align=\"center\">a</td></tr>\n\n<tr><td>b</td></tr>\n</table>\n\n",
  "\n\n    \n\n<body>\n<table role=\"presentation\" border=\"0\"><tr><td align=\"center\">a</td></tr>\n\n<tr><td>b</td></tr>\n</table>\n</body>\n"
 ]
];

test("html_sanitize of a full html document", () => {
  for (const [src, plain, style, attrs, outgoing] of DOC_CASES) {
    assert.equal(htmlSanitize(src, FN_DEFAULT), plain, src);
    assert.equal(htmlSanitize(src, { ...FN_DEFAULT, sanitizeStyle: true }), style, src);
    assert.equal(htmlSanitize(src, { ...FN_DEFAULT, sanitizeAttributes: true, sanitizeStyle: true }), attrs, src);
    assert.equal(htmlSanitize(src, { sanitizeTags: false, sanitizeAttributes: false, sanitizeStyle: true, sanitizeForm: true, stripStyle: false, stripClasses: false, xmlOutput: true }), outgoing, src);
  }
});
