/**
 * XML-RPC as Python's `xmlrpc.client` speaks it (cpython Lib/xmlrpc/client.py `loads` with use_datetime=True, and
 * `Marshaller.dumps`) with Odoo's marshaller (odoo/addons/rpc/controllers/xmlrpc.py:74-127 `OdooMarshaller`,
 * `dumps`): dates and datetimes as strings, control characters removed, no `None` (allow_none=False).
 */
import { pyFloatRepr } from "./json";

export class XmlRpcError extends Error {}

/** A datetime result (marshalled as its string, OdooMarshaller.dump_datetime). */
export class XmlRpcDateTime {
  constructor(readonly value: string) {}
}

interface Node { tag: string; children: Node[]; text: string }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** A small XML reader for methodCall documents (elements and text; no attributes are needed by the format). */
function parseXml(xml: string): Node {
  const root: Node = { tag: "#root", children: [], text: "" };
  const stack: Node[] = [root];
  const re = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3] !== undefined) {
      if (m[2] === "/") {
        if (stack.length < 2 || top.tag !== m[3]) throw new XmlRpcError(`mismatched tag: ${m[3]}`);
        stack.pop();
      } else {
        const node: Node = { tag: m[3], children: [], text: "" };
        top.children.push(node);
        if (m[4] !== "/") stack.push(node);
      }
    } else if (m[5] !== undefined) top.text += decodeEntities(m[5]);
  }
  if (stack.length !== 1) throw new XmlRpcError("unclosed element");
  return root;
}

function decodeValue(value: Node): unknown {
  const typed = value.children[0];
  if (!typed) return value.text; // a bare <value>text</value> is a string
  switch (typed.tag) {
    case "string": return typed.text;
    case "int": case "i4": case "i8": case "i1": case "i2": case "biginteger": {
      const t = typed.text.trim();
      if (!/^[+-]?\d+$/.test(t)) throw new XmlRpcError(`bad int: ${t}`);
      return Number(t);
    }
    case "boolean": {
      const t = typed.text.trim();
      if (t === "0") return false;
      if (t === "1") return true;
      throw new TypeError("bad boolean value");
    }
    case "double": case "float": return Number(typed.text.trim());
    case "nil": return null;
    // use_datetime=True gives a datetime, which the ORM takes as "YYYY-MM-DD HH:MM:SS"
    case "dateTime.iso8601": {
      const t = typed.text.trim();
      const m = /^(\d{4})-?(\d{2})-?(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(t);
      if (!m) throw new XmlRpcError(`bad datetime: ${t}`);
      return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}`;
    }
    case "base64": return typed.text.replace(/\s+/g, "");
    case "array": {
      const data = typed.children.find((c) => c.tag === "data");
      return (data?.children ?? []).filter((c) => c.tag === "value").map(decodeValue);
    }
    case "struct": {
      const out: Record<string, unknown> = {};
      for (const member of typed.children.filter((c) => c.tag === "member")) {
        const name = member.children.find((c) => c.tag === "name");
        const v = member.children.find((c) => c.tag === "value");
        if (!name || !v) throw new XmlRpcError("bad struct member");
        out[name.text] = decodeValue(v);
      }
      return out;
    }
    default: throw new XmlRpcError(`unknown type: ${typed.tag}`);
  }
}

/** `xmlrpc.client.loads(data, use_datetime=True)` of a methodCall: (params, methodName). */
export function loadsCall(xml: string): { params: unknown[]; method: string } {
  const root = parseXml(xml);
  const call = root.children.find((c) => c.tag === "methodCall");
  if (!call) throw new XmlRpcError("not a methodCall");
  const name = call.children.find((c) => c.tag === "methodName");
  const params = call.children.find((c) => c.tag === "params");
  const values = (params?.children ?? []).filter((c) => c.tag === "param").map((p) => {
    const v = p.children.find((c) => c.tag === "value");
    if (!v) throw new XmlRpcError("param without value");
    return decodeValue(v);
  });
  return { params: values, method: name?.text ?? "" };
}

const MAXINT = 2 ** 31 - 1;
const MININT = -(2 ** 31);

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** OdooMarshaller.dump_unicode: control characters 0-31 but tab, newline and carriage return are removed. */
function cleanString(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}

function isPyFloatLike(v: unknown): v is { float: number } {
  return typeof v === "object" && v !== null && "float" in v && typeof (v as { float: unknown }).float === "number" && Object.keys(v).length <= 2;
}

function dumpValue(v: unknown, out: string[]): void {
  if (v === null || v === undefined) throw new TypeError("cannot marshal None unless allow_none is enabled");
  if (v === true || v === false) out.push(`<value><boolean>${v ? 1 : 0}</boolean></value>\n`);
  else if (typeof v === "number") {
    if (Number.isInteger(v)) {
      if (v > MAXINT || v < MININT) throw new RangeError("int exceeds XML-RPC limits");
      out.push(`<value><int>${v}</int></value>\n`);
    } else out.push(`<value><double>${pyFloatRepr(v)}</double></value>\n`);
  } else if (isPyFloatLike(v)) out.push(`<value><double>${pyFloatRepr(v.float)}</double></value>\n`);
  else if (typeof v === "string") out.push(`<value><string>${escape(cleanString(v))}</string></value>\n`);
  else if (v instanceof XmlRpcDateTime) out.push(`<value><string>${v.value}</string></value>\n`);
  else if (v instanceof Date) out.push(`<value><string>${v.toISOString().slice(0, 19).replace("T", " ")}</string></value>\n`);
  else if (Array.isArray(v)) {
    out.push("<value><array><data>\n");
    for (const x of v) dumpValue(x, out);
    out.push("</data></array></value>\n");
  } else if (v instanceof Map) {
    out.push("<value><struct>\n");
    for (const [k, x] of v) {
      if (typeof k !== "string") throw new TypeError("dictionary key must be string");
      out.push(`<member>\n<name>${escape(k)}</name>\n`);
      dumpValue(x, out);
      out.push("</member>\n");
    }
    out.push("</struct></value>\n");
  } else if (typeof v === "object") {
    out.push("<value><struct>\n");
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      out.push(`<member>\n<name>${escape(k)}</name>\n`);
      dumpValue(x, out);
      out.push("</member>\n");
    }
    out.push("</struct></value>\n");
  } else throw new TypeError(`cannot marshal ${typeof v} objects`);
}

function wrap(body: string): string {
  return `<?xml version="1.0"?>\n<methodResponse>\n${body}\n</methodResponse>\n`;
}

/** rpc/controllers/xmlrpc.py:130-137 `dumps((result,))`. */
export function dumpsResult(result: unknown): string {
  const out: string[] = ["<params>\n", "<param>\n"];
  dumpValue(result, out);
  out.push("</param>\n", "</params>\n");
  return wrap(out.join(""));
}

/** `dumps(Fault(code, string))`. */
export function dumpsFault(code: number | string, message: string): string {
  const out: string[] = ["<fault>\n"];
  dumpValue({ faultCode: code, faultString: message }, out);
  out.push("</fault>\n");
  return wrap(out.join(""));
}
