/** tools/date_utils.py `get_fiscal_year`, without imports (unit-tested in src/models/fiscal_year.test.ts). */
const daysIn = (y: number, m: number): number => new Date(Date.UTC(y, m, 0)).getUTCDate();
const ymdStr = (y: number, m: number, d: number): string => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/** tools/date_utils.py:245-275 `get_fiscal_year(date, day, month)`: the first and last day of the fiscal year of `date`. */
export function fiscalYear(date: string, day: number, month: number): [string, string] {
  const fixDay = (y: number, m: number, d: number): number => {
    const max = daysIn(y, m);
    return m === 2 && (d === 28 || d === max) ? max : Math.min(d, max);
  };
  const y = Number(date.slice(0, 4));
  let to: [number, number, number] = [y, month, fixDay(y, month, day)];
  const toStr = (t: [number, number, number]): string => ymdStr(...t);
  // relativedelta(years=±1): the same month, the day clipped to it
  const addYears = (t: [number, number, number], n: number): [number, number, number] => [t[0] + n, t[1], Math.min(t[2], daysIn(t[0] + n, t[1]))];
  const plusDay = (t: string): string => new Date(Date.parse(`${t}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  if (date <= toStr(to)) {
    let from = addYears(to, -1);
    from = [from[0], from[1], fixDay(from[0], from[1], from[2])];
    return [plusDay(toStr(from)), toStr(to)];
  }
  const from = plusDay(toStr(to));
  to = addYears(to, 1);
  to = [to[0], to[1], fixDay(to[0], to[1], to[2])];
  return [from, toStr(to)];
}
