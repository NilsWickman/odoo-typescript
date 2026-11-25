import { test } from "node:test";
import assert from "node:assert/strict";
import { VAT_MODULES } from "./vat_stdnum";

// [country, number, stdnum compact, stdnum is_valid] from python-stdnum 1.19 (.venv, get_cc_module(cc, 'vat'), 2026-11-13)
const CASES: [string, string, string, boolean][] = [
  // CO: Odoo's format_vat_co (base res_partner.py:2362-2368) and stdnum's co.nit.is_valid of it
  ["CO", "75101643", "7510164-3", true],
  // stdnum.sg.uen (python-stdnum 1.19, 2026)
  ["SG", "197401143C", "197401143C", true],
  ["SG", "53056424E", "53056424E", false],
  ["SG", " 53056424e ", "53056424E", false],
  ["SG", "T08GB0002B", "T08GB0002B", false],
  ["SG", "R90SS0001A", "R90SS0001A", true],
  ["SG", "S99XX9999X", "S99XX9999X", false],
  ["SG", "201912345Z", "201912345Z", false],
  ["SG", "00000000X", "00000000X", true],
  ["SG", "123", "123", false],
  ["SG", "T99LP1234A", "T99LP1234A", false],
  ["SG", "S16FC0121D", "S16FC0121D", true],
  ["SG", "52844279B", "52844279B", false],
  ["CO", "7510164-3", "7510164-3", true],
  ["CO", "213123432-1", "213123432-1", true],
  ["CO", "213.123.432-1", "213123432-1", true],
  ["CO", "213123432-2", "213123432-2", false],
  ["CO", "8001972684", "800197268-4", true],
  ["CO", "800.197.268-4", "800197268-4", true],
  ["CO", "co800197268", "CO80019726-8", false],
  ["CO", "12", "12", false],
  ["CO", "1234567", "123456-7", false],
  ["CO", "ABC123456789", "ABC12345678-9", false],
  ["CO", "900 373 913-4", "900373913-4", true],
  ["CO", "90037391349999999", "9003739134999999-9", false],
  ["IE", "IE1519572A", "1519572A", true],
  ["IE", "1519572A", "1519572A", true],
  ["IE", "IE1234567FA", "1234567FA", true],
  ["IE", "IE 1234567 T", "1234567T", true],
  ["IE", "8Z49289F", "8Z49289F", true],
  ["IE", "IE8Z49289F", "8Z49289F", true],
  ["IE", "1234567X", "1234567X", false],
  ["IE", "IE123456", "123456", false],
  ["IE", "IE12345678W", "12345678W", false],
  ["IE", "IE1234567WH", "1234567WH", true],
  ["IE", "ie-6433435f", "6433435F", true],
  ["IE", "IE6433435OA", "6433435OA", true],
  ["IE", "IE+4910281", "+4910281", false],
  ["NL", "NL219987701B73", "219987701B73", true],
  ["NL", "NL123456782B90", "123456782B90", true],
  ["NL", "NL004495445B01", "004495445B01", true],
  ["NL", "NL4495445B01", "004495445B01", true],
  ["NL", "NL123456789B12", "123456789B12", false],
  ["NL", "NL 0044.95.445.B01", "004495445B01", true],
  ["NL", "NL12345678B90", "012345678B90", false],
  ["NL", "NL123456782C90", "123456782C90", false],
  ["NL", "NL000000000B00", "000000000B00", false],
  ["NL", "NL219987701B00", "219987701B00", false],
  ["NL", "NL00000000B01", "000000000B01", false],
  ["AT", "ATU12345675", "U12345675", true],
  ["AT", "ATU 1234 5675", "U12345675", true],
  ["AT", "AT U13585627", "U13585627", true],
  ["AT", "U13585627", "U13585627", true],
  ["AT", "ATU13585626", "U13585626", false],
  ["AT", "ATU1234567", "U1234567", false],
  ["AT", "ATX12345675", "X12345675", false],
  ["AT", "atu-12345675", "U12345675", true],
  ["AT", "ATU1358562.7", "U13585627", true],
  ["LT", "LT949170611", "949170611", true],
  ["LT", "LT123456715", "123456715", true],
  ["LT", "LT 1194 1612 1", "119416121", false],
  ["LT", "119511515", "119511515", true],
  ["LT", "LT100001919017", "100001919017", true],
  ["LT", "LT100004801610", "100004801610", true],
  ["LT", "LT123456789", "123456789", false],
  ["LT", "LT12345678901", "12345678901", false],
  ["LT", "LT949170612", "949170612", false],
  ["LT", "LT1234567890123", "1234567890123", false],
];

test("stdnum 1.19 compact and is_valid of the IE, NL, AT and LT VAT modules, and CO (Odoo's format_vat_co)", () => {
  for (const [cc, number, compact, valid] of CASES) {
    const m = VAT_MODULES[cc]!;
    assert.equal(m.compact(number), compact, `${cc} compact(${number})`);
    assert.equal(m.isValid(number), valid, `${cc} is_valid(${number})`);
  }
});

// [country, number, stdnum compact, the check `_check_vat_number` makes of the compact number]: NO by Odoo's own
// check_vat_no (base res_partner.py:2102-2126), LU by stdnum lu.tva.is_valid, AU by au.abn.is_valid, GT by Odoo's check_vat_gt (res_partner.py:1983-1991) (python-stdnum 1.19, .venv, 2026-11-13)
const CHECKED: [string, string, string, boolean][] = [
  ["NO", "NO072274687MVA", "072274687MVA", true],
  ["NO", "072274687MVA", "072274687MVA", true],
  ["NO", "NO 072 274 687 MVA", "072274687MVA", true],
  ["NO", "NO123456785", "123456785", true],
  ["NO", "NO123456785MVA", "123456785MVA", true],
  ["NO", "NO123456789", "123456789", false],
  ["NO", "NO12345678", "12345678", false],
  ["NO", "974760673", "974760673", true],
  ["NO", "NO974760673MVA", "974760673MVA", true],
  ["NO", "NO99999999MVA", "99999999MVA", false],
  ["LU", "LU75425064", "75425064", true],
  ["LU", "LU12345613", "12345613", true],
  ["LU", "75425064", "75425064", true],
  ["LU", "LU 7542.5064", "75425064", true],
  ["LU", "LU12345678", "12345678", false],
  ["LU", "LU1234561", "1234561", false],
  ["LU", "LU-12345613", "12345613", true],
  ["AU", "83 914 571 673", "83914571673", true],
  ["AU", "83914571673", "83914571673", true],
  ["AU", "51 824 753 556", "51824753556", true],
  ["AU", "51824753556", "51824753556", true],
  ["AU", "51824753557", "51824753557", false],
  ["AU", "12345678901", "12345678901", false],
  ["AU", "8391457167", "8391457167", false],
  ["AU", "839145716733", "839145716733", false],
  ["AU", " 83 914 571 673 ", "83914571673", true],
  ["AU", "AU83914571673", "AU83914571673", false],
  ["AU", "00000000000", "00000000000", false],
  ["AU", "83-914-571-673", "83-914-571-673", false],
  ["AU", "53 004 085 616", "53004085616", true],
  ["GT", "576937-K", "576937K", true],
  ["GT", "576937K", "576937K", true],
  ["GT", "5769370", "5769370", false],
  ["GT", "39525503", "39525503", true],
  ["GT", "3952550-3", "39525503", true],
  ["GT", "0039525503", "39525503", true],
  ["GT", "7108-0", "71080", true],
  ["GT", "1", "1", false],
  ["GT", "12", "12", false],
  ["GT", "123456789012K", "123456789012K", false],
  ["GT", "27K", "27K", false],
  ["GT", "11201220K", "11201220K", true],
  ["GT", "11201350K", "11201350K", true],
  ["GT", "980000000000K", "980000000000K", true],
  ["GT", "980000000000KX", "980000000000KX", true],
  ["GT", "98000000000K", "98000000000K", false],
  ["GT", "2002 7044 - 2", "200270442", false],
  ["GT", "k76937", "K76937", false],
  ["GT", "5768", "5768", false],
  ["GT", "-0", "", false],
  ["GT", "00000", "", false],
  ["GT", "1234567890123", "1234567890123", false],
  ["GT", "12345678901-9", "123456789019", false],
];

test("NO, LU, AU and GT: stdnum's compact, and the check of the compact number", () => {
  for (const [cc, number, compact, valid] of CHECKED) {
    const m = VAT_MODULES[cc]!;
    assert.equal(m.compact(number), compact, `${cc} compact(${number})`);
    assert.equal(m.isValid(compact), valid, `${cc} check(${compact})`);
  }
});
