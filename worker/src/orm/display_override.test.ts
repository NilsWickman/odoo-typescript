import { test } from "node:test";
import assert from "node:assert/strict";
import type { Cursor } from "../db";
import { refuseOverriddenDisplayName } from "./display_override";

test("a display_name override without a hook refuses on every path", () => {
  const cr = {} as Cursor;
  // project_collaborator.py `_compute_display_name` ("Office Design - Joel Willis"): the generic name would be wrong
  assert.throws(() => refuseOverriddenDisplayName("project.collaborator", cr), /not ported: display_name of project.collaborator/);
  // res.currency keeps BaseModel's `_compute_display_name`
  assert.doesNotThrow(() => refuseOverriddenDisplayName("res.currency", cr));
});
