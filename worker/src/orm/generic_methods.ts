/**
 * The models of a site's new modules whose public ORM method is BaseModel's own (compiler/oc/module_keys.py `generic`,
 * gen/orm_methods.py's criterion), per template: the compiled build registers the hand port's generic implementation
 * for them (compiler/runtime/install.ts genericKey) and notes them here, as poc_erp's gen/out/poc_erp/orm_methods.json
 * lists the base's models.
 */
const GENERIC = new Map<string, Set<string>>();

export function noteGenericMethod(template: string, model: string, method: string): void {
  const k = `${model}|${method}`;
  const set = GENERIC.get(k) ?? new Set<string>();
  set.add(template);
  GENERIC.set(k, set);
}

/** Whether `model`'s `method` is BaseModel's own on the template (a model of its new modules). */
export function genericMethod(template: string, model: string, method: string): boolean {
  return GENERIC.get(`${model}|${method}`)?.has(template) ?? false;
}
