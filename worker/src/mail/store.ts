/** mail/tools/discuss.py Store._build_result: merge records, sort models/fields,
 * retain insertion order of records, and attach the transaction snapshot. */
import type { Cursor } from '../db';
import { storeVersion } from '../bus/presence';

export class Store {
  private models = new Map<string, Map<number|string, Record<string, unknown>>>();
  private globals: Record<string, unknown> = {};
  private versioned = false;
  add(model: string, id: number|string, values: Record<string, unknown> = {}, nativeRecord = true): void {
    this.versioned ||= nativeRecord;
    let records = this.models.get(model);
    if (!records) this.models.set(model, records = new Map());
    records.set(id, {...records.get(id), id, ...values});
  }
  global(values: Record<string, unknown>): void { Object.assign(this.globals, values); }
  /** A data request answered from the ORM carries the transaction snapshot even without records (Odoo's Store). */
  markVersioned(): void { this.versioned = true; }
  async asDict(cr: Cursor): Promise<Record<string, unknown>> {
    const sorted = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const result: Record<string, unknown> = {};
    if (Object.keys(this.globals).length) result['Store'] = sorted(this.globals);
    for (const [model, records] of [...this.models].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (records.size) result[model] = [...records.values()].map(sorted);
    }
    if (this.versioned) result['__store_version__'] = await storeVersion(cr, {});
    return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a==='__store_version__'?1:b==='__store_version__'?-1:a<b?-1:a>b?1:0));
  }
}
