// src/modules/xml_translate.ts against Odoo's own `StoredTranslations.translated` and `ParsedTranslation.terms`: views of
// a poc_erp build database (compiler/xml_translate_cases.py, GEN_DB=dev_cmp_empty, 2026-11-11), the smallest ones
// and those with markup terms, t-attf attributes and stored French translations. The whole set (1 785 views) is in
// results/vagb-b2/xml_cases.json: identical, none refused (compiler/VAGB.md, B2 step 2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { translatedChanges, xmlTerms } from "./xml_translate";

interface Case {
  id: number;
  values: Record<string, string>;
  terms: string[];
  updates: Record<string, Record<string, string>>;
  active: string[];
  results: [Record<string, string | null>, Record<string, string | null>];
}

const cases = JSON.parse(readFileSync(fileURLToPath(new URL("../../test/xml_translate_cases.json", import.meta.url).href), "utf8")) as Case[];

test("xml_translate: the terms of a view's arch, as ParsedTranslation extracts them", () => {
  for (const c of cases) assert.deepEqual(xmlTerms(c.values["en_US"]!), c.terms, `view ${c.id}`);
});

test("StoredTranslations.translated: the changed languages, without and with overwrite", () => {
  for (const c of cases) {
    const updates = new Map(Object.entries(c.updates).map(([l, m]) => [l, new Map(Object.entries(m))]));
    for (const [i, overwrite] of [false, true].entries()) {
      assert.deepEqual(translatedChanges(c.values, updates, new Set(c.active), overwrite), c.results[i], `view ${c.id} overwrite=${overwrite}`);
    }
  }
});
