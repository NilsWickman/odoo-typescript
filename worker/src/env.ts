/** A Workers VPC network binding: raw TCP to an address behind its Cloudflare Tunnel (plaintext only). */
export interface VpcNetwork {
  connect(address: string): Socket;
}

/** Bindings and variables of the Worker (wrangler.jsonc). */
export interface Env {
  readonly SESSION: DurableObjectNamespace;
  readonly BUS: DurableObjectNamespace;
  /** Files written at runtime, one FilestoreObject per database (src/do/filestore.ts). */
  readonly FILESTORE_DO: DurableObjectNamespace<import("./do/filestore").FilestoreObject>;
  readonly ASSETS: Fetcher;
  /** JSON: slot database name -> Hyperdrive binding name, e.g. {"slot_1": "HD_1"}. */
  readonly SLOTS: string;
  /**
   * Experiment only (D18): a PBKDF2 round count accepted without Odoo's re-hash to 600,000 (res_users.py:90, 1322).
   * Hashes with exactly this count are verified in the Worker with node:crypto; unset = Odoo's behaviour.
   */
  readonly EXPERIMENT_PASSWORD_ROUNDS?: string;
  /** Local development only (start.sh): Odoo's `proxy_mode`, trust X-Forwarded-Host/Proto from the harness's front proxy. */
  readonly PROXY_MODE?: string;
  /** Local development only (start.sh): a DSN with `{db}` in place of the database name. */
  readonly PG_DSN_TEMPLATE?: string;
  /** Local development only: a filestore root with one directory per database (dbs.py). */
  readonly FILESTORE_ROOT?: string;
  /** Deployed Worker version (wrangler.jsonc version_metadata), shown on /proof. */
  readonly CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** Odoo's `dbfilter` (router.py:87-122): a regex with %h/%d; set in production so the one exposed database is chosen. */
  readonly DB_FILTER?: string;
  /** The database /proof queries (deploy.sh), or several separated by commas, the first that answers; unset = none,
   * on the demo the Runbot's two (src/proof_logic.ts proofDbs; deploy-demo.sh sets them). */
  readonly PROOF_DB?: string;
  /** Local development only (start.sh): no PDF engine, and the proof route of the PDF parts. */
  readonly LOCAL_DEV?: string;
  /** Browser Run (wrangler.jsonc `browser`): the PDF engine of /report/pdf; absent locally (as the oracle: no engine). */
  /** A regex of the databases that get the PDF engine (deploy.sh: the production database); unset = every database. */
  readonly PDF_ENGINE_DBS?: string;
  /** D25 (deploy.sh): a regex of the databases whose Apps list only the modules this Worker can serve
   *  (src/modules/apps_visible.ts); unset = every module, as Odoo. */
  readonly APPS_INSTALLABLE_DBS?: string;
  readonly BROWSER?: { quickAction(action: "pdf", options: Record<string, unknown>): Promise<Response> };
  /** The Cloudflare Tunnel to the VPS's Postgres (wrangler.jsonc `vpc_networks`); used when PG_TUNNEL is "1". */
  readonly PG_NET?: VpcNetwork;
  /** deploy.sh: "1" = connect to PG_DSN_TEMPLATE's host through PG_NET; unset locally (direct TCP). */
  readonly PG_TUNNEL?: string;
  /** deploy.sh: the databases whose ir_cron jobs and files' mirroring the scheduled() handler runs (comma-separated). */
  readonly CRON_DBS?: string;
  /** The files' mirroring budget per scheduled run (src/filestore_files.ts DEFAULT_BUDGET); unset = the default. */
  readonly FILES_MIRROR_MAX_FILES?: string;
  readonly FILES_MIRROR_MAX_BYTES?: string;
  /** Local development only (start.sh, with LOCAL_DEV): another name for the files database (src/filestore_mirror.ts filesDb). */
  readonly FILES_DB_NAME?: string;
  /** Demo mode (wrangler.demo.jsonc): "1" activates DemoPool routing, queue, private slots, and shared Runbot. */
  readonly DEMO_MODE?: string;
  /** Durable Object managing demo slots, FIFO queue, and Runbot rotation (src/do/demo_pool.ts). */
  readonly DEMO_POOL?: DurableObjectNamespace<import("./do/demo_pool").DemoPool>;
  readonly DEMO_BASE_DOMAIN?: string;
  readonly DEMO_LAUNCHER_HOST?: string;
  readonly DEMO_RUNBOT_HOST?: string;
  readonly DEMO_SLOT_PREFIX?: string;
  readonly DEMO_SLOTS?: string;
  readonly DEMO_IDLE_MS?: string;
  readonly DEMO_RUNBOT_RESET_MS?: string;
  readonly DEMO_TEMPLATE_DB?: string;
  readonly DEMO_DB_OWNER?: string;
  /** Hard lease cap from the claim in ms (default 1_800_000), whatever the activity. */
  readonly DEMO_MAX_LEASE_MS?: string;
  /** Active leases per IPv4 /32 or IPv6 /64 (default 3; one queue entry besides). */
  readonly DEMO_MAX_SLOTS_PER_IP?: string;
  /** `pg_database_size` cap of one demo database in bytes (default 268_435_456). */
  readonly DEMO_MAX_DB_BYTES?: string;
  /** Secret: bearer token of `/__demo/admin/*` only. */
  readonly DEMO_ADMIN_TOKEN?: string;
  /** Secret: value of `X-Demo-Admin-Bypass` that passes the maintenance 503 (nothing else). */
  readonly DEMO_BYPASS_TOKEN?: string;
  /** Cloudflare Turnstile on `POST /__demo/enter`: both set = widget rendered and verified; unset = skipped. */
  readonly TURNSTILE_SITE_KEY?: string;
  readonly TURNSTILE_SECRET_KEY?: string;
  /** Request-scoped (src/demo/router.ts scopedDemoEnv): the lease a PDF quota is charged to, "runbot" or a slot index. */
  readonly DEMO_LEASE_SLOT?: string;
  readonly DEMO_LEASE_SECRET?: string;
  /** Shared fallback key in the files database for template attachments (e.g. "demo_template"). */
  readonly TEMPLATE_FILES_DB_KEY?: string;
  readonly [hyperdrive: `HD_${number}`]: Hyperdrive | undefined;
}
