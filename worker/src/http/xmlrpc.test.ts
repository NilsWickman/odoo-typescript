import { strict as assert } from "node:assert";
import { test } from "node:test";
import { dumpsFault, dumpsResult, loadsCall } from "./xmlrpc";

// expectations from cpython's xmlrpc.client.dumps (Lib/xmlrpc/client.py), wrapped as rpc/controllers/xmlrpc.py `dumps`
const inner = (s: string): string => s.split("<methodResponse>\n")[1]!.split("</methodResponse>")[0]!.replace(/^\n+|\n+$/g, "");

test("a result is marshalled as Python's Marshaller", () => {
  const out = dumpsResult([{ id: 7, name: "A & <b>", ok: true, f: { float: 70 }, list: [1, 2.5, "x"], empty: [] }]);
  assert.ok(out.startsWith('<?xml version="1.0"?>\n<methodResponse>\n<params>\n'));
  assert.equal(inner(out), "<params>\n<param>\n<value><array><data>\n<value><struct>\n<member>\n<name>id</name>\n<value><int>7</int></value>\n</member>\n<member>\n<name>name</name>\n<value><string>A &amp; &lt;b&gt;</string></value>\n</member>\n<member>\n<name>ok</name>\n<value><boolean>1</boolean></value>\n</member>\n<member>\n<name>f</name>\n<value><double>70.0</double></value>\n</member>\n<member>\n<name>list</name>\n<value><array><data>\n<value><int>1</int></value>\n<value><double>2.5</double></value>\n<value><string>x</string></value>\n</data></array></value>\n</member>\n<member>\n<name>empty</name>\n<value><array><data>\n</data></array></value>\n</member>\n</struct></value>\n</data></array></value>\n</param>\n</params>");
});

test("a fault is marshalled with its code and string", () => {
  assert.equal(inner(dumpsFault(4, "Private methods (such as 'x._y') cannot be called remotely.")), "<fault>\n<value><struct>\n<member>\n<name>faultCode</name>\n<value><int>4</int></value>\n</member>\n<member>\n<name>faultString</name>\n<value><string>Private methods (such as 'x._y') cannot be called remotely.</string></value>\n</member>\n</struct></value>\n</fault>");
});

test("None cannot be marshalled (allow_none=False)", () => {
  assert.throws(() => dumpsResult(null), /cannot marshal None/);
  assert.throws(() => dumpsResult(2 ** 31), /int exceeds XML-RPC limits/);
});

test("a methodCall from xmlrpc.client is read with its types", () => {
  const { method, params } = loadsCall("<?xml version='1.0'?>\n<methodCall>\n<methodName>execute_kw</methodName>\n<params>\n<param>\n<value><string>db</string></value>\n</param>\n<param>\n<value><int>2</int></value>\n</param>\n<param>\n<value><string>pw</string></value>\n</param>\n<param>\n<value><string>res.partner</string></value>\n</param>\n<param>\n<value><string>search</string></value>\n</param>\n<param>\n<value><array><data>\n<value><array><data>\n<value><array><data>\n<value><string>name</string></value>\n<value><string>ilike</string></value>\n<value><string>a&amp;b</string></value>\n</data></array></value>\n</data></array></value>\n</data></array></value>\n</param>\n<param>\n<value><struct>\n<member>\n<name>limit</name>\n<value><int>5</int></value>\n</member>\n<member>\n<name>d</name>\n<value><dateTime.iso8601>20261105T01:02:03</dateTime.iso8601></value>\n</member>\n<member>\n<name>f</name>\n<value><double>1.5</double></value>\n</member>\n<member>\n<name>n</name>\n<value><nil/></value></member>\n</struct></value>\n</param>\n</params>\n</methodCall>\n");
  assert.equal(method, "execute_kw");
  assert.deepEqual(params, ["db", 2, "pw", "res.partner", "search", [[["name", "ilike", "a&b"]]], { limit: 5, d: "2026-11-05 01:02:03", f: 1.5, n: null }]);
});
