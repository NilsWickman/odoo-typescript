/**
 * A module manifest as `Manifest._from_path` reads it (odoo/modules/module.py:178-366): `ast.literal_eval` of
 * `__manifest__.py`, then `_load_manifest` (:452-512) fills `_DEFAULT_MANIFEST` (:60-98), defaults `depends` to
 * ['base'], normalizes `auto_install` and adapts the version (:579-608).
 */
import { isDict, dictEntries, literalEval } from "../pyexpr";

export const MANIFEST_NAMES = ["__manifest__.py"]; // module.py:57
export const MODULE_NAME_RE = /^\w{1,256}$/u; // module.py:56
const MAJOR_VERSION = "20.0"; // odoo/release.py:15-16

const DEFAULT_MANIFEST: Readonly<Record<string, unknown>> = {
  application: false, bootstrap: false, assets: {}, auto_install: false, category: "Uncategorized", cloc_exclude: [],
  configurator_snippets: {}, configurator_snippets_addons: {}, countries: [], data: [], demo: [], depends: [],
  description: "", external_dependencies: {}, iap_paid_service: false, installable: true, images: [], kpi_providers: [],
  live_test_url: "", new_page_templates: {}, other_files: [], post_init_hook: "", post_load: "", pre_init_hook: "",
  sequence: 100, summary: "", test: [], theme_customizations: {}, uninstall_hook: "", version: "1.0", web: false, website: "",
};

/** Python values of the literal as plain JS: dicts become objects (manifests have string keys). */
function plain(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(plain);
  if (isDict(v)) return Object.fromEntries(dictEntries(v).map(([k, x]) => [String(k), plain(x)]));
  return v;
}

/** module.py:579-596 `adapt_version`. */
export function adaptVersion(version: string): string {
  const parts = version.split(".");
  if (!(parts.length >= 2 && parts.length <= 5)) throw new Error(`Invalid version '${version}', must have between 2 and 5 parts`);
  if (version.startsWith(MAJOR_VERSION) && !/^\d+$/.test(parts[0]!)) parts[0] = parts[0]!.replace(/\D/g, "");
  if (!parts.every((p) => /^\s*[+-]?\d+\s*$/.test(p))) throw new Error(`Invalid version '${version}'`);
  if (parts.length <= 3 && !version.startsWith(MAJOR_VERSION)) return `${MAJOR_VERSION}.${version}`;
  return version;
}

export interface Manifest {
  readonly name: string;
  /** The cleaned manifest (`__manifest_cached`). */
  readonly values: Readonly<Record<string, unknown>>;
  /** `Manifest.version`. */
  readonly version: string;
  /** `Manifest.description`: the manifest's, else the first README file. */
  readonly description: string;
  get<T = unknown>(key: string): T;
}

/**
 * `Manifest._from_path(path)`: null when the file cannot be evaluated (module.py:362-363 logs and skips it).
 * `readme` gives the README files of the module directory (README.rst, .md, .txt, README), when any.
 */
export function readManifest(name: string, text: string, readme: (file: string) => string | null): Manifest | null {
  let content: unknown;
  try {
    content = plain(literalEval(text));
  } catch {
    return null;
  }
  if (typeof content !== "object" || content === null || Array.isArray(content)) return null;
  if (!MODULE_NAME_RE.test(name)) throw new Error(`Invalid module name: ${name}`);
  const m: Record<string, unknown> = { ...structuredClone(DEFAULT_MANIFEST), ...(content as Record<string, unknown>) };
  if (!m["author"]) m["author"] = String(m["contributors"] || m["maintainer"] || "");
  if (!m["license"]) m["license"] = "LGPL-3";
  if (name === "base") m["depends"] = [];
  else if (!(m["depends"] as unknown[]).length) m["depends"] = ["base"];
  const depends = m["depends"] as string[];
  if (Array.isArray(m["auto_install"])) {
    const set = m["auto_install"] as string[];
    if (set.some((d) => !depends.includes(d))) throw new Error(`auto_install triggers must be dependencies, for module ${name}`);
    m["auto_install"] = [...new Set(set)];
  } else if (m["auto_install"]) m["auto_install"] = [...new Set(depends)];
  try {
    m["version"] = adaptVersion(String(m["version"]));
  } catch (e) {
    if (m["installable"]) throw new Error(`Module ${name}: invalid manifest`, { cause: e });
  }
  if (m["installable"] && !String(m["version"]).startsWith(MAJOR_VERSION + ".")) m["installable"] = false;
  let description = m["description"] ? String(m["description"]) : "";
  if (!description) {
    for (const f of ["README.rst", "README.md", "README.txt", "README"]) {
      const t = readme(f);
      if (t !== null) { description = t; break; }
    }
  }
  return {
    name, values: m, description,
    version: (() => { try { return String(m["version"]); } catch { return adaptVersion("1.0"); } })(),
    get<T>(key: string): T {
      if (key === "description") return description as T;
      if (key === "version") return String(m["version"]) as T;
      return structuredClone(m[key]) as T;
    },
  };
}
