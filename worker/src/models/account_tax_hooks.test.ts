// src/models/account_tax_hooks.ts: the tax engine's grouping keys as Odoo's dicts. Without an override, a base line's
// key and the key of the tax line it creates compare as the hand port's string key compared them before (taxes and
// tags as sets, an empty analytic distribution as none); a key an override adds compares as Python's `==`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PrivateRecords } from "../orm/private_hooks";
import { RECORDS_MODEL } from "../orm/private_hooks";
import { baseLineGroupingKeyHand, taxLineKey, taxLineRepGroupingKeyHand } from "./account_tax_hooks";

const env = {} as never;
const R = (model: string, ...ids: number[]): PrivateRecords => new PrivateRecords(model, ids);
const fromCompiled = (model: string, ...ids: number[]): number[] => Object.defineProperty([...ids], RECORDS_MODEL, { value: model });

/** The key before (src/models/account_move_create.ts taxLineKey at 07df6559). */
function oldKey(rep: number, account: number, tags: readonly number[], taxIds: readonly number[], group: number | null, analytic: unknown, partner: unknown, currency: unknown): string {
  return JSON.stringify([rep, partner ?? null, currency ?? null, group ?? null, analytic && Object.keys(analytic as object).length ? analytic : null, account,
    [...taxIds].sort((a, b) => a - b), [...tags].sort((a, b) => a - b)]);
}

function taxLine(o: { rep: number; partner: number | null; currency: number; group: number | null; analytic: unknown; account: number; taxes: number[]; tags: number[] }) {
  return {
    tax_repartition_line_id: R("account.tax.repartition.line", o.rep), partner_id: R("res.partner", ...(o.partner ? [o.partner] : [])),
    currency_id: R("res.currency", o.currency), group_tax_id: R("account.tax", ...(o.group ? [o.group] : [])), analytic_distribution: o.analytic,
    account_id: R("account.account", o.account), tax_ids: R("account.tax", ...o.taxes), tax_tag_ids: R("account.account.tag", ...o.tags),
  };
}

test("tax line keys compare as the hand port's string keys did", async () => {
  const cases = [
    { rep: 5, partner: 7, currency: 1, group: null, analytic: null, account: 40, taxes: [], tags: [3, 1] },
    { rep: 5, partner: 7, currency: 1, group: null, analytic: {}, account: 40, taxes: [], tags: [1, 3] },
    { rep: 5, partner: null, currency: 1, group: null, analytic: null, account: 40, taxes: [], tags: [] },
    { rep: 6, partner: 7, currency: 1, group: 2, analytic: { "12": 100 }, account: 41, taxes: [9, 8], tags: [1] },
    { rep: 6, partner: 7, currency: 2, group: 2, analytic: { "12": 100 }, account: 41, taxes: [8, 9], tags: [1] },
  ];
  for (const a of cases) {
    for (const b of cases) {
      const ka = taxLineKey(await taxLineRepGroupingKeyHand(env, taxLine(a)), "a").key;
      const kb = taxLineKey(await taxLineRepGroupingKeyHand(env, taxLine(b)), "b").key;
      const oa = oldKey(a.rep, a.account, a.tags, a.taxes, a.group, a.analytic, a.partner, a.currency);
      const ob = oldKey(b.rep, b.account, b.tags, b.taxes, b.group, b.analytic, b.partner, b.currency);
      assert.equal(ka === kb, oa === ob, `${JSON.stringify(a)} / ${JSON.stringify(b)}`);
    }
  }
});

test("a key an override adds: compared as Python compares it, carried as the created line's value", async () => {
  const base = { rep: 5, partner: 7, currency: 1, group: null, analytic: null, account: 40, taxes: [], tags: [1] };
  const own = await taxLineRepGroupingKeyHand(env, taxLine(base));
  const k0 = taxLineKey(own, "own");
  assert.deepEqual(k0.extras, {});
  const kFalse = taxLineKey({ ...own, vehicle_id: false }, "fleet");
  const kZero = taxLineKey({ ...own, vehicle_id: 0 }, "fleet");
  const kSome = taxLineKey({ ...own, vehicle_id: 3 }, "fleet");
  assert.notEqual(kFalse.key, k0.key);
  assert.equal(kFalse.key, kZero.key); // False == 0 in Python
  assert.notEqual(kFalse.key, kSome.key);
  assert.deepEqual(kSome.extras, { vehicle_id: 3 });
  // `__` keys are left out of the comparison (account_tax.py:3123-3133), `__keep_zero_line` is read
  const kKeep = taxLineKey({ ...own, vehicle_id: 3, __keep_zero_line: true }, "us");
  assert.equal(kKeep.key, kSome.key);
  assert.equal(kKeep.keep, true);
});

test("a base line from compiled code (ids with their model) gives the hand port's key", async () => {
  const hand = await baseLineGroupingKeyHand(env, { partner_id: R("res.partner", 7), currency_id: R("res.currency", 1), analytic_distribution: null,
    account_id: R("account.account", 40), tax_ids: R("account.tax", 2, 3) });
  const compiled = await baseLineGroupingKeyHand(env, { partner_id: fromCompiled("res.partner", 7), currency_id: fromCompiled("res.currency", 1), analytic_distribution: null,
    account_id: fromCompiled("account.account", 40), tax_ids: fromCompiled("account.tax", 2, 3) });
  assert.deepEqual(compiled, hand);
  assert.deepEqual(hand, { partner_id: 7, currency_id: 1, analytic_distribution: null, account_id: 40, tax_ids: [[6, 0, [2, 3]]] });
  await assert.rejects(baseLineGroupingKeyHand(env, { partner_id: R("res.partner", 7) }), /KeyError/);
  await assert.rejects(baseLineGroupingKeyHand(env, { partner_id: R("res.partner", 7, 8), currency_id: R("res.currency", 1), analytic_distribution: null,
    account_id: R("account.account", 40), tax_ids: R("account.tax") }), /singleton/);
});
