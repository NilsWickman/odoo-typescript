/** Types of the JavaScript copy of Odoo's tax engine (account_tax_engine.js). */
export interface TaxCurrency {
  readonly id: number;
  readonly rounding: number;
  readonly decimal_places: number;
}
export interface TaxGroupData {
  readonly id: number;
  readonly name: string;
  readonly preceding_subtotal: string | false;
  readonly pos_receipt_label: string | false;
}
export interface TaxData {
  readonly id: number;
  readonly name: string;
  readonly amount_type: string;
  readonly amount: number;
  readonly sequence: number;
  readonly price_include: boolean;
  readonly price_include_override: string | false;
  readonly include_base_amount: boolean;
  readonly is_base_affected: boolean;
  readonly has_negative_factor: boolean;
  readonly children_tax_ids: readonly TaxData[];
  readonly tax_group_id: TaxGroupData;
}
export interface TaxCompany {
  readonly currency_id: TaxCurrency;
  readonly tax_calculation_rounding_method: string;
}
export interface BaseLineRecord {
  readonly id: number;
  readonly tax_ids: readonly TaxData[];
  readonly price_unit: number;
  readonly quantity: number;
  readonly discount: number;
  readonly currency_id: TaxCurrency;
  readonly rate: number;
  readonly product_id: Record<string, never>;
  readonly product_uom_id: Record<string, never>;
  readonly document_tax_mode: string | null;
  /** The stored `extra_tax_data` (account_tax.py:1409-1462 import). */
  readonly extra_tax_data?: Readonly<Record<string, unknown>>;
  readonly analytic_distribution?: Readonly<Record<string, unknown>> | null;
}
/** One tax of a base line's tax details (the rounded amounts may be adjusted, account_tax.py:2126-2203). */
export interface BaseLineTaxData {
  readonly tax: TaxData;
  tax_amount_currency: number;
  tax_amount: number;
}
/** A base line after `add_tax_details_in_base_lines` / `round_base_lines_tax_details`. */
export interface BaseLine {
  readonly currency_id: TaxCurrency;
  readonly tax_details: {
    readonly taxes_data: BaseLineTaxData[];
    readonly total_excluded_currency: number;
    readonly total_included_currency: number;
    readonly total_excluded: number;
    readonly total_included: number;
    readonly raw_total_excluded_currency: number;
    readonly raw_total_included_currency: number;
  };
}
export interface TaxTotalsSummary {
  readonly base_amount_currency: number;
  readonly tax_amount_currency: number;
  readonly total_amount_currency: number;
  readonly [key: string]: unknown;
}
export const accountTaxHelpers: {
  prepare_base_line_for_taxes_computation(record: BaseLineRecord, kwargs?: Readonly<Record<string, unknown>>): BaseLine;
  add_tax_details_in_base_lines(baseLines: BaseLine[], company: TaxCompany): void;
  round_base_lines_tax_details(baseLines: BaseLine[], company: TaxCompany): void;
  get_tax_totals_summary(baseLines: BaseLine[], currency: TaxCurrency, company: TaxCompany): TaxTotalsSummary;
  /** account_tax.py:3894-3931 `_prepare_down_payment_lines`. */
  prepare_down_payment_lines(baseLines: BaseLine[], company: TaxCompany, amountType: "percent" | "fixed", amount: number, opts?: { readonly computation_key?: string }): BaseLine[];
  /** account_tax.py:1375-1407 `_export_base_line_extra_tax_data`. */
  export_base_line_extra_tax_data(baseLine: BaseLine): Record<string, unknown>;
  /** account_tax.py:1463-1486 `_reverse_quantity_base_line_extra_tax_data`. */
  reverse_quantity_base_line_extra_tax_data(extraTaxData: Readonly<Record<string, unknown>> | null): Record<string, unknown> | null;
  /** account_tax.py:1118-1373 `_get_tax_details` (the JavaScript mirror). */
  get_tax_details(taxes: readonly TaxData[], priceUnit: number, quantity: number, opts?: {
    readonly precision_rounding?: number | null; readonly rounding_method?: "round_per_line" | "round_globally";
    readonly document_tax_mode?: string | null;
  }): { readonly total_excluded: number; readonly total_included: number;
    readonly taxes_data: readonly { readonly tax: TaxData; readonly tax_amount: number; readonly base: number }[] };
  distribute_delta_amount_smoothly(precisionDigits: number, deltaAmount: number, targetFactors: readonly { readonly factor: number }[], opts?: { readonly allow_negative_factors?: boolean }): number[];
};
export function roundPrecision(value: number, precision: number, method?: string): number;
export function floatIsZero(value: number, decimals: number): boolean;
export function setTaxEngineTranslator(fn: (s: string) => string): void;
