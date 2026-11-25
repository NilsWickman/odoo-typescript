/**
 * The models whose `display_name` is not BaseModel's `_compute_display_name` (models.py:1504): a module overrides the
 * method or the field's compute (gen/orm_methods.py over poc_corpus and poc_erp, union). Without a `displayName` hook
 * the port does not know their names, so every path refuses instead of showing the generic `_rec_name` value. All of
 * them have a hook since 2026-11-04 (src/models/display_names.ts); this stays as the guard for new modules.
 */
import type { Cursor } from "../db";
import { NotPorted } from "../errors";
import genCorpus from "../../gen/out/orm_methods.json" with { type: "json" };
import genErp from "../../gen/out/poc_erp/orm_methods.json" with { type: "json" };

const OVERRIDDEN = new Set<string>([...genCorpus.display_name_override, ...genErp.display_name_override]);

export function refuseOverriddenDisplayName(model: string, _cr: Cursor): void {
  if (OVERRIDDEN.has(model)) throw new NotPorted(`display_name of ${model} (its own _compute_display_name)`);
}
