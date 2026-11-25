import { test } from "node:test";
import assert from "node:assert/strict";
import { NotPorted } from "../errors";
import type { Environment } from "../orm/types";
import { refuseUnportedDemo } from "./chart_load";

/** An env whose ir_module_module holds the given (name, state) rows. */
function envWith(mods: Record<string, string>): Environment {
  const live = new Set(["installed", "to install", "to upgrade", "to remove"]);
  return {
    cr: {
      query: async (_sql: string, params: unknown[]) => ({
        rows: (params[0] as string[]).filter((n) => live.has(mods[n] ?? "")).sort().map((name) => ({ name })),
      }),
    },
  } as unknown as Environment;
}

const POC_ERP = { l10n_us_account: "installed", l10n_be: "installed", l10n_us: "installed" };

test("a demo load of us refuses: l10n_us_account's own demo data is not ported", async () => {
  await assert.rejects(refuseUnportedDemo(envWith(POC_ERP), "us"), (e: unknown) => e instanceof NotPorted && /l10n_us_account for the chart template us/.test(String((e as Error).message)));
});

test("l10n_us_account counts while its own data loads", async () => {
  await assert.rejects(refuseUnportedDemo(envWith({ l10n_us_account: "to install" }), "us"), NotPorted);
});

test("other codes of the poc_erp templates go on (l10n_be's and l10n_us_account's are for be and us)", async () => {
  for (const code of ["se", "cn", "cn_large_bis", "zm", "kr"]) await refuseUnportedDemo(envWith(POC_ERP), code);
});

test("a child template inherits its parent's demo functions; a generic one refuses every code", async () => {
  await assert.rejects(refuseUnportedDemo(envWith(POC_ERP), "be_comp"), NotPorted);
  await assert.rejects(refuseUnportedDemo(envWith({ l10n_br: "installed" }), "se"), NotPorted);
  await refuseUnportedDemo(envWith({ l10n_br: "uninstalled" }), "se");
});
