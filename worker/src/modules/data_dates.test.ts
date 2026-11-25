import { strict as assert } from "node:assert";
import { test } from "node:test";
import { evalExprAsync, PyObject } from "../pyexpr";
import { dataDateFieldValue, PyDataDatetime, PyRelativedelta, PyTimedelta } from "./data_dates";
import type { FieldDef } from "../orm/types";

// Python 3.12 with dateutil 2.8.2 (Odoo's venv), now = datetime(2026, 1, 31, 23, 59, 58, 123456), measured 2026-11-15
const CASES: [string, string][] = [
  ["(DateTime.now() - timedelta(days=336)).strftime('%Y-%m-%d')", "2025-03-01"],
  ["(DateTime.now() + timedelta(-5)).strftime('%Y-%m-%d')", "2026-01-26"],
  ["(DateTime.now() + timedelta(3)).strftime('%Y-%m-%d %H:%M:%S')", "2026-02-03 23:59:58"],
  ["(DateTime.now() + timedelta(days=1, hours=2, minutes=3)).strftime('%Y-%m-%d %H:%M:%S')", "2026-02-02 02:02:58"],
  ["(DateTime.now() + relativedelta(months=1)).strftime('%Y-%m-%d')", "2026-02-28"],
  ["(DateTime.now() + relativedelta(months=13)).strftime('%Y-%m-%d')", "2027-02-28"],
  ["(DateTime.now() - relativedelta(months=11, days=3)).strftime('%Y-%m-%d %H:%M')", "2025-02-25 23:59"],
  ["(DateTime.now() + relativedelta(years=-2, months=-3)).strftime('%Y-%m-%d')", "2023-10-31"],
  ["(DateTime.now() + relativedelta(weekday=0, weeks=-1)).strftime('%Y-%m-%d')", "2026-01-26"],
  ["(DateTime.now() + relativedelta(weekday=4)).strftime('%Y-%m-%d')", "2026-02-06"],
  ["(DateTime.now() + relativedelta(day=1, months=1, hour=8, minute=0, second=0)).strftime('%Y-%m-%d %H:%M:%S')", "2026-02-01 08:00:00"],
  ["(DateTime.now() + relativedelta(hours=30, minutes=-90)).strftime('%Y-%m-%d %H:%M:%S')", "2026-02-02 04:29:58"],
  ["(datetime.now() - timedelta(seconds=86401)).strftime('%Y-%m-%d %H:%M:%S')", "2026-01-30 23:59:57"],
  ["(DateTime.today() - relativedelta(days=10)).strftime('%Y-%m-%d %H:%M:%S')", "2026-01-21 23:59:58"],
  ["(datetime.now()+relativedelta(years=-1)).strftime('%Y-01-01')", "2025-01-01"],
];

class FixedNow extends PyObject {
  pyGetAttr(name: string): unknown {
    if (name !== "now" && name !== "today") throw new Error(name);
    return () => PyDataDatetime.of(2026, 1, 31, 23, 59, 58, 123456);
  }
}

const scope = (): Map<string, unknown> => new Map<string, unknown>([
  ["DateTime", new FixedNow()], ["datetime", new FixedNow()], ["timedelta", PyTimedelta.make], ["relativedelta", PyRelativedelta.make],
]);

test("data file dates: datetime, timedelta and relativedelta as Python and dateutil compute them", async () => {
  for (const [expr, want] of CASES) assert.equal(await evalExprAsync(expr, scope()), want, expr);
});

test("data file dates: the value of a Date or Datetime field, others refuse", async () => {
  const dt = await evalExprAsync("DateTime.today() - relativedelta(days=3)", scope()) as PyDataDatetime;
  assert.equal(dataDateFieldValue({ type: "date" } as FieldDef, dt), "2026-01-28");
  assert.equal((dataDateFieldValue({ type: "datetime" } as FieldDef, dt) as { text: string }).text, "2026-01-28 23:59:58.123456");
  assert.throws(() => dataDateFieldValue({ type: "char" } as FieldDef, dt), /not ported/);
  await assert.rejects(evalExprAsync("DateTime.now() - DateTime.now()", scope()), /not ported/);
  await assert.rejects(evalExprAsync("relativedelta(leapdays=1)", scope()), /not ported/);
  await assert.rejects(evalExprAsync("timedelta(days=1.5)", scope()), /not ported/);
  await assert.rejects(evalExprAsync("DateTime.now().strftime('%A')", scope()), /not ported/);
});
