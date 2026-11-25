import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { trackingBody } from './tracking';
import { formatAddr, emailNormalize, plaintextBody } from './message';
import { formatAddress } from '../models/mail_address';

test('tracking body orders by sequence then name and escapes like the sanitized template (S2 db_diff)', () => {
  assert.equal(trackingBody([{ name: 'phone', sequence: 2, label: 'Phone', old: '+32 2 555 01 99', new: '+32 2 555 02 00' }]),
    '<div>+32 2 555 01 99 → <b>+32 2 555 02 00</b> <i>(Phone)</i>\n</div>');
  assert.equal(trackingBody([
    { name: 'vat', sequence: 5, label: 'TIN', old: 'None', new: 'X' },
    { name: 'name', sequence: 1, label: 'Name', old: 'A', new: "B & 'C' <d>" },
    { name: 'email', sequence: 1, label: 'Email', old: 'a', new: 'b' },
  ]), "<div>a → <b>b</b> <i>(Email)</i><br>A → <b>B &amp; 'C' &lt;d&gt;</b> <i>(Name)</i><br>None → <b>X</b> <i>(TIN)</i>\n</div>");
});

test('formataddr quotes ASCII names and base64-encodes the others (tools/mail.py:1041)', () => {
  assert.equal(formatAddr('Mitchell Admin', 'admin@example.com'), '"Mitchell Admin" <admin@example.com>');
  assert.equal(formatAddr('A "b"', 'x@y.z'), '"A \\"b\\"" <x@y.z>');
  assert.equal(formatAddr('Hélène', 'h@y.z'), '=?utf-8?b?SMOpbMOobmU=?= <h@y.z>');
  assert.equal(emailNormalize(' Azure.Interior24@Example.com '), 'azure.interior24@example.com');
});

test('plain text bodies are wrapped and escaped', () => {
  assert.equal(plaintextBody('Contact created'), '<p>Contact created</p>');
  assert.equal(plaintextBody('a & b'), '<p>a &amp; b</p>');
});

test('address formatting collapses spaces and drops empty lines (res_partner.py:1310)', () => {
  assert.equal(formatAddress('%(street)s\n%(street2)s\n%(city)s %(state_code)s %(zip)s\n%(country_name)s',
    { street: '4557 De Silva St', street2: '', city: 'Fremont', state_code: 'CA', zip: '94538', country_name: 'United States' }, ', '),
  '4557 De Silva St, Fremont CA 94538, United States');
  assert.equal(formatAddress('%(street)s\n%(city)s  %(zip)s', { street: '', city: 'X', zip: '' }, ', '), 'X');
  // `format % args`: a value's % is text (Odoo's demo partner 'Société 100% Bio 27'), a format's other directive refuses
  assert.equal(formatAddress('%(parent_name)s\n%(city)s', { parent_name: 'Société 100% Bio 27', city: '' }, ', '), 'Société 100% Bio 27');
  assert.throws(() => formatAddress('%(city)s %d', { city: 'X' }, ', '), /other % directives/);
});

import { activityDoneBody } from './activity';
test('activity done body matches the QWeb output of mail.message_activity_done (checked against Odoo)', () => {
  assert.equal(activityDoneBody('check', 'Call the CEO', null, 'Done, CEO agreed'),
    '<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled" data-icon="check"></span>\n        <span>Call the CEO</span>\n    </p>\n    <div>\n            Done, CEO agreed\n    </div>\n</div>');
  assert.equal(activityDoneBody('check', null, null, null),
    '<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled" data-icon="check"></span>\n    </p>\n</div>');
  assert.equal(activityDoneBody('check', 'S & <x>', null, 'line1\nline2'),
    '<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled" data-icon="check"></span>\n        <span>S &amp; &lt;x&gt;</span>\n    </p>\n    <div>\n            line1\n            <br>\n            line2\n    </div>\n</div>');
  assert.equal(activityDoneBody('check', 'Sum', 'Marc Demo', 'fb'),
    '<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled" data-icon="check"></span>\n        <span>Sum</span>\n         (originally assigned to <span>Marc Demo</span>)\n    </p>\n    <div>\n            fb\n    </div>\n</div>');
  assert.equal(activityDoneBody('check', 'Sum', null, 'a\n\nb\n'),
    '<div>\n    <p class="o_mail_activity_title mb-1">\n        <span class="oi oi-fw oi-filled" data-icon="check"></span>\n        <span>Sum</span>\n    </p>\n    <div>\n            a\n            <br>\n            \n            <br>\n            b\n            <br>\n            \n    </div>\n</div>');
});

import { indexContent, imageSize, guessMimetype } from './attachment';
test('upload metadata: mimetype, index_content and PNG size as Odoo stores them (S3/S6 db_diff)', () => {
  const note = new TextEncoder().encode('Hello from the runtime phase.\nA second line.\n');
  assert.equal(guessMimetype('note.txt', note), 'text/plain');
  assert.equal(guessMimetype('logo.PNG', note), 'image/png');
  // mimetypes.guess_type of the oracle's interpreter, lowercased (_compute_mimetype)
  assert.equal(guessMimetype('readme.md', note), 'text/markdown');
  assert.equal(guessMimetype('Book.XLSM', note), 'application/vnd.ms-excel.sheet.macroenabled.12');
  assert.equal(guessMimetype('page.html', note), 'text/html');
  assert.equal(guessMimetype('logo.svg', note), 'image/svg+xml');
  assert.equal(guessMimetype('notes.log', new Uint8Array()), 'application/octet-stream');
  assert.throws(() => guessMimetype('notes.log', note), /guess_mimetype/);
  assert.throws(() => guessMimetype('blob.bin', note), /guess_mimetype/);
  assert.equal(indexContent(note, 'text/plain'), 'Hello from the runtime phase.\nA second line.');
  assert.equal(indexContent(new Uint8Array([0x41, 0x42, 0x43, 0x00, 0x44, 0x45, 0x46, 0x47]), 'text/plain'), 'DEFG');
  assert.equal(indexContent(note, 'image/png'), null);
  const png = new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d4948445200000280000001e0', 'hex'));
  assert.deepEqual(imageSize(png, 'image/png'), [640, 480]);
});

import { sanitizeBody } from './sanitize';
test('message bodies are sanitized like html_sanitize for inline composer markup (pairs from Odoo)', () => {
  const pairs: [string, string][] = [
    ['Hello <a href="/odoo/res.partner/6" class="o_mail_redirect" data-oe-id="6" data-oe-model="res.partner" target="_blank" contenteditable="false">@Marc Demo</a>  please check the address.',
      '<p>Hello <a href="/odoo/res.partner/6" class="o_mail_redirect" data-oe-id="6" data-oe-model="res.partner" target="_blank">@Marc Demo</a> &nbsp;please check the address.</p>'],
    ['line1<br>line2', '<p>line1<br>line2</p>'], ['a & b', '<p>a &amp; b</p>'], ['<b>bold</b> text', '<span><b>bold</b> text</span>'],
    ['<u>u</u>', '<u>u</u>'], ['<br>lead', '<span><br>lead</span>'], [' spaced ', '<p>spaced </p>'], ['1 < 2 > 0', '<p>1 &lt; 2 &gt; 0</p>'],
    ['a "quoted" \'s\'', '<p>a "quoted" \'s\'</p>'], ['tail <br>', '<p>tail <br></p>'], ['Internal note with a file', '<p>Internal note with a file</p>'],
    ["The transaction <a href=# data-oe-model='payment.transaction' data-oe-id='1'>INV/2026/00008</a> of $\u00a0750.00 has been confirmed.",
      '<p>The transaction <a href="#" data-oe-model="payment.transaction" data-oe-id="1">INV/2026/00008</a> of $&nbsp;750.00 has been confirmed.</p>'],
    ['<a href=/my/x title=a>x</a>', '<a href="/my/x" title="a">x</a>'],
  ];
  for (const [src, want] of pairs) assert.equal(sanitizeBody(src), want, src);
  // block markup goes through the general sanitizer (pairs from Odoo, proofs/scenarios/post_html.py)
  assert.equal(sanitizeBody('<p>block</p>'), '<p>block</p>');
  assert.equal(sanitizeBody('<ul><li>a</li></ul>'), '<ul><li>a</li></ul>');
  assert.equal(sanitizeBody('<script>alert(1)</script><p>x</p>'), '<p>x</p>');
  // tag_quote (tools/mail.py:178-288) marks a quote (Odoo's html_sanitize with the body's options, 2026-11-07)
  assert.equal(sanitizeBody('<blockquote>q</blockquote>'), '<blockquote data-o-mail-quote-node="1" data-o-mail-quote="1">q</blockquote>');
  assert.throws(() => sanitizeBody('<a href="javascript:alert(1)">x</a>'));
});

import { readFileSync, existsSync } from 'node:fs';
import { emailLayout } from './notify_layout';
test('notification email layout equals the S3/C3 reference bodies (user and customer groups)', () => {
  const ref = new URL('../../../harness/corpus/runtime/ref/frozen-2026-10-28/', import.meta.url).pathname;
  if (!existsSync(`${ref}S3/db_diff.json`)) return;
  const s3 = JSON.parse(readFileSync(`${ref}S3/db_diff.json`, 'utf8')) as { mail_mail: { added: { body_html: string }[] } };
  const body = '<p>Hello <a href="/odoo/res.partner/6" class="o_mail_redirect" data-oe-id="6" data-oe-model="res.partner" target="_blank">@Marc Demo</a> &nbsp;please check the address.</p>';
  const common = { lang: 'en_US', subtypeInternal: false, preview: 'Hello @Marc Demo please check the address.', subtitles: ['Azure Interior'], body,
    signature: '<div>-- <br/><div>Mitchell Admin</div></div>', primaryColor: '#FFFFFF', secondaryColor: '#875A7B' };
  assert.equal(emailLayout({ ...common, button: { url: 'http://B/mail/view?model=res.partner&res_id=16', title: 'View Contact' } }).replaceAll('http://B', '<base_url>'), s3.mail_mail.added[0]!.body_html);
  assert.equal(emailLayout({ ...common, button: null }), s3.mail_mail.added[1]!.body_html);
});

test('activity assignment email (forced header and footer) equals the S3 reference body', () => {
  const ref = new URL('../../../harness/corpus/runtime/ref/frozen-2026-10-28/', import.meta.url).pathname;
  if (!existsSync(`${ref}S3/db_diff.json`)) return;
  const s3 = JSON.parse(readFileSync(`${ref}S3/db_diff.json`, 'utf8')) as { mail_mail: { added: { body_html: string }[] }; mail_message: { added: { id: number; body: string }[] } };
  const body = s3.mail_message.added.find(m => m.id === 790)!.body;
  const out = emailLayout({
    lang: 'en_US', subtypeInternal: true, body, signature: '<div>-- <br/><div>Mitchell Admin</div></div>',
    preview: 'Dear Marc Demo, Mitchell Admin has just assigned you the following activity on document "Azure Interior" (Contact): Check the address - deadline: 11/02/2026',
    button: { url: 'http://B/mail/view?model=res.partner&res_id=16', title: 'View Contact' }, subtitles: ['Activity: To-Do', 'Deadline: 11/02/2026'],
    primaryColor: '#FFFFFF', secondaryColor: '#875A7B',
    footer: { name: 'YourCompany', phone: '+1 555-555-5556', email: 'info@yourcompany.com', website: 'http://www.example.com' },
  }).replaceAll('http://B', '<base_url>');
  assert.equal(out, s3.mail_mail.added[2]!.body_html);
});

test('pdf_first_page reproduces PyPDF2 2.12.1 for the S6 offer.pdf (sha256 of Odoo extract_page output)', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const { extractFirstPage } = await import('./pdf_first_page');
  const pdf = new Uint8Array(readFileSync(new URL('../../../harness/corpus/runtime/files/offer.pdf', import.meta.url).pathname));
  const out = extractFirstPage(pdf);
  assert.equal(out.length, 992);
  assert.equal(createHash('sha256').update(out).digest('hex'), 'da386741d4f0728f1db87db1a242ce1fdf4a3394cdb10883625a6f84110695bd');
});
