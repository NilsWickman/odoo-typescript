/**
 * The compiled builds of this bundle (compiler/select.py writes the call into src/compiled/index.ts): the templates
 * whose build is installed, and every template that has a build at all (compiler/out at select time). A template with
 * a build that this bundle does not carry (a site deployed with another site's module set, D9) cannot be served: its
 * modules' compiled keys are missing. The hand variant registers nothing.
 */
const INSTALLED = new Set<string>();
const KNOWN = new Set<string>();

export function registerBuilds(installed: readonly string[], known: readonly string[]): void {
  for (const t of installed) INSTALLED.add(t);
  for (const t of known) KNOWN.add(t);
}

/** Whether `template` needs a compiled build this bundle does not have. */
export function buildMissing(template: string): boolean {
  return KNOWN.has(template) && !INSTALLED.has(template);
}

export function installedBuilds(): readonly string[] {
  return [...INSTALLED];
}
