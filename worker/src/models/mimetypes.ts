/**
 * Python's `mimetypes.guess_type(url)[0]` (CPython 3.12 Lib/mimetypes.py:103-170, strict) with the oracle's tables
 * (gen/out/mimetypes.json from gen/mimetypes_table.py: CPython defaults, the host's /etc/mime.types and Odoo's
 * odoo/odoo/_monkeypatches/mimetypes.py). Inputs whose parsing goes through branches not ported here (data: urls,
 * control characters urllib strips) refuse.
 */
import { NotPorted } from "../errors";
import table from "../../gen/out/mimetypes.json" with { type: "json" };

interface Tables { types_map: Record<string, string>; suffix_map: Record<string, string>; encodings_map: Record<string, string> }
const t: Tables = table;

/** genericpath.py `_splitext` with sep '/', no altsep: the extension from the last dot, ignoring leading dots. */
export function splitext(p: string): [string, string] {
  const sepIndex = p.lastIndexOf("/");
  const dotIndex = p.lastIndexOf(".");
  if (dotIndex > sepIndex) {
    for (let i = sepIndex + 1; i < dotIndex; i++) if (p[i] !== ".") return [p.slice(0, dotIndex), p.slice(dotIndex)];
  }
  return [p, ""];
}

/** urllib.parse.urlparse(url): the scheme (lowercased, "" when none) and the path, for the inputs ported here. */
function urlparse(url: string): [string, string] {
  // parse.py:396-400 strips leading C0 controls and spaces and removes tab/CR/LF anywhere
  if (/^[\x00-\x20]/.test(url) || /[\t\r\n]/.test(url)) throw new NotPorted("mimetypes.guess_type of a name with control characters");
  const m = /^([A-Za-z][A-Za-z0-9+\-.]*):/.exec(url);
  if (!m) return ["", url];
  let rest = url.slice(m[0].length);
  if (rest.startsWith("//")) {
    const end = rest.slice(2).search(/[/?#]/);
    rest = end < 0 ? "" : rest.slice(2 + end);
  }
  const cut = rest.search(/[?#]/);
  return [m[1]!.toLowerCase(), cut < 0 ? rest : rest.slice(0, cut)];
}

/** `mimetypes.guess_type(url)[0]` (strict): null when unknown. */
export function guessType(url0: string): string | null {
  let url = url0;
  const [scheme, path] = urlparse(url0);
  if (scheme.length > 1) url = path; // :123-129 (os.path.splitdrive is a no-op on posix)
  if (scheme === "data") throw new NotPorted("mimetypes.guess_type of a data: url");
  let [base, ext] = splitext(url);
  for (let lower = ext.toLowerCase(); Object.hasOwn(t.suffix_map, lower); lower = ext.toLowerCase()) {
    [base, ext] = splitext(base + t.suffix_map[lower]!);
  }
  // encodings_map is case sensitive
  if (Object.hasOwn(t.encodings_map, ext)) [base, ext] = splitext(base);
  const lower = ext.toLowerCase();
  return Object.hasOwn(t.types_map, lower) ? t.types_map[lower]! : null;
}
