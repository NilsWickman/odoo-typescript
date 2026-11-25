/**
 * Upload caps of the public demo (`DEMO_MODE=1` only, src/filestore.ts writeFile): 2 MiB per file and 20 MiB of
 * runtime-written files per database (one FilestoreObject per slot or Runbot side). The private Worker is uncapped
 * (40 MiB chunked uploads, src/do/filestore.ts).
 */
export const DEMO_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const DEMO_MAX_STORE_BYTES = 20 * 1024 * 1024;

/** The refusal of writing `size` new bytes into a store already holding `used`, or null when allowed. */
export function demoUploadRefusal(size: number, used: number): string | null {
  if (size > DEMO_MAX_FILE_BYTES) return "Files in the public demo are limited to 2 MiB each.";
  if (used + size > DEMO_MAX_STORE_BYTES) return "This demo has reached its 20 MiB upload limit. Reset the demo to start fresh.";
  return null;
}
