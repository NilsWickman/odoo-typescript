import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The registrations are read from the sources (registering them needs the Workers runtime): every `registerOnchange`
// must be an `@api.onchange` method of its model in Odoo with the same fields (gen/onchange_methods.py), or one of
// the other mechanisms src/orm/onchange_methods.ts runs after Odoo's methods.
const SRC = fileURLToPath(new URL("..", import.meta.url).href);
const GEN = fileURLToPath(new URL("../../gen/out/", import.meta.url).href);
const MECHANISMS = new Set(["account.move._compute_name_of_lines"]);

type Gen = { models: Record<string, { fields: Record<string, string[]>; methods: Record<string, { fields: string[] }> }> };
const gens: Gen[] = ["onchange_methods.json", "poc_erp/onchange_methods.json", "poc_erp_se/onchange_methods.json"]
  .map((p) => JSON.parse(readFileSync(GEN + p, "utf8")) as Gen);

function registrations(): { model: string; name: string; fields: string[]; file: string }[] {
  const out: { model: string; name: string; fields: string[]; file: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = dir + e.name;
      if (e.isDirectory()) { walk(p + "/"); continue; }
      if (!p.endsWith(".ts") || p.endsWith(".test.ts")) continue;
      const s = readFileSync(p, "utf8");
      const consts = new Map([...s.matchAll(/const (MODEL|S) = "([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
      for (const m of s.matchAll(/registerOnchange\((MODEL|S|"[^"]+"), "([^"]+)", (\[[^\]]*\])/g)) {
        out.push({ model: consts.get(m[1]!) ?? m[1]!.slice(1, -1), name: m[2]!, fields: JSON.parse(m[3]!) as string[], file: p });
      }
      // settings_computes.ts registers through a local `on(name, fields, fn)` for res.config.settings
      if (p.endsWith("settings_computes.ts")) {
        for (const m of s.matchAll(/\non\("([^"]+)", (\[[^\]]*\])/g)) out.push({ model: "res.config.settings", name: m[1]!, fields: JSON.parse(m[2]!) as string[], file: p });
      }
    }
  };
  walk(SRC);
  return out;
}

test("every onchange registration is Odoo's method with its fields, or a listed mechanism", () => {
  const regs = registrations();
  assert.ok(regs.length >= 50, `found ${regs.length} registrations`);
  for (const r of regs) {
    const key = `${r.model}.${r.name}`;
    const found = gens.map((g) => g.models[r.model]?.methods[r.name]).filter((m) => m !== undefined);
    if (MECHANISMS.has(key)) { assert.equal(found.length, 0, `${key} is an Odoo onchange method now`); continue; }
    assert.ok(found.length, `${key} (${r.file}) is no @api.onchange method of Odoo`);
    // a module may decorate an override for fewer fields (l10n_se `account.move._onchange_partner_id`): the
    // registration lists the union over the templates, and each template's fields are among them
    const union = [...new Set(found.flatMap((m) => m.fields))].sort();
    assert.deepEqual(union, [...r.fields].sort(), `${key} fields`);
  }
});

test("the generated lists name every method of a field in Odoo's order (by name, then change_default)", () => {
  for (const g of gens) {
    for (const [model, m] of Object.entries(g.models)) {
      for (const [field, names] of Object.entries(m.fields)) {
        const methods = names.filter((n) => n !== "<change_default>");
        assert.deepEqual(methods, [...methods].sort(), `${model}.${field}`);
        for (const n of methods) assert.ok(m.methods[n]?.fields.includes(field), `${model}.${n} on ${field}`);
        assert.ok(names.indexOf("<change_default>") === -1 || names.at(-1) === "<change_default>", `${model}.${field} change_default last`);
      }
    }
  }
});
