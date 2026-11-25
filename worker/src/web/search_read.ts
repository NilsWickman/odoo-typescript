/**
 * `web_search_read` (`odoo/addons/web/models/models.py:130-189`): search_fetch, web_read, then the `length` rule of
 * `_format_web_search_read_results` with `count_limit` and `force_search_count`.
 */
import type { Domain, Environment, RecordValues } from "../orm/types";
import { registerBaseMethod } from "./register";
import { boolArg, envFor, intArg, optInt, optStr, parseSpecification, type Specification } from "./common";
import { parseDomain } from "../orm/domain";
import { webRead } from "./read";

export interface WebSearchReadResult {
  length: number;
  records: RecordValues[];
}

export async function webSearchRead(
  env: Environment,
  model: string,
  domain: Domain,
  specification: Specification,
  offset = 0,
  limit: number | null = null,
  order: string | null = null,
  countLimit: number | null = null,
): Promise<WebSearchReadResult> {
  // models.py:162: search_fetch(domain, list(specification), offset, limit, order); `order=''` falls back to _order
  const ids = await env.model(model).search(domain, { offset, limit, order: order === "" ? null : order });
  const records = await webRead(env, model, ids, specification);
  return formatWebSearchReadResults(env, model, domain, records, offset, limit, countLimit);
}

/** models.py:166-189. */
export async function formatWebSearchReadResults(
  env: Environment,
  model: string,
  domain: Domain,
  records: RecordValues[],
  offset: number,
  limit: number | null,
  countLimit: number | null,
): Promise<WebSearchReadResult> {
  if (records.length === 0) return { length: 0, records: [] };
  const currentLength = records.length + offset;
  const limitReached = records.length === limit;
  const forceSearchCount = boolArg(env.context["force_search_count"]);
  const countLimitReached = countLimit !== null && countLimit !== 0 && countLimit <= currentLength;
  let length = currentLength;
  if (limit !== null && limit !== 0 && ((limitReached && !countLimitReached) || forceSearchCount)) {
    length = await env.model(model).searchCount(domain, countLimit);
  }
  return { length, records };
}

registerBaseMethod("web_search_read", async (env0, _ids, args, kwargs0, model) => {
  const { env, kwargs } = envFor(env0, kwargs0);
  // positional order: domain, specification, offset, limit, order, count_limit
  const domain = parseDomain(kwargs["domain"] ?? args[0]);
  const spec = parseSpecification(kwargs["specification"] ?? args[1]);
  const offset = intArg(kwargs["offset"] ?? args[2], "offset", 0);
  const limit = optInt(kwargs["limit"] ?? args[3], "limit");
  const order = optStr(kwargs["order"] ?? args[4], "order");
  const countLimit = optInt(kwargs["count_limit"] ?? args[5], "count_limit");
  return webSearchRead(env, model, domain, spec, offset, limit, order, countLimit);
}, { apiModel: true, readonly: true });
