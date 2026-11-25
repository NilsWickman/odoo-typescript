/**
 * Generated data too big for the Worker bundle, served from the ASSETS binding under `/__gen/` (copied there from
 * gen/out by gen/filestore.py for deploys and by start.sh locally). The Worker runs first for every request
 * (wrangler.jsonc `run_worker_first`) and never routes `/__gen/`, so these files are not public.
 */
import { NotPorted } from "./errors";

let assets: Fetcher | null = null;

/** src/index.ts sets the binding at the start of every request (one Worker, one binding). */
export function setGenAssets(binding: Fetcher | undefined): void {
  if (binding) assets = binding;
}

/** The parsed JSON of `gen/out/<path>` as packaged under `/__gen/<path>`. */
export async function genAssetJson(path: string): Promise<unknown> {
  if (assets === null) throw new NotPorted(`generated asset ${path}: no ASSETS binding`);
  const res = await assets.fetch(new Request(`http://assets/__gen/${path}`));
  if (res.status === 404) throw new NotPorted(`generated asset ${path} is not packaged (gen/filestore.py, start.sh)`);
  if (!res.ok) throw new Error(`ASSETS binding: ${res.status} for /__gen/${path}`);
  return res.json();
}
