# Worker-centred password derivation experiment

Odoo's TypeScript HTTP dispatch, controllers, user lookup, authorization, ORM, SQL,
QWeb and authentication decision remain in the ordinary Worker. The existing native
`SessionStore` Durable Object already covers per-session state and now also exposes
one pure-computation RPC, `derivePassword(passwordBytes, saltBytes)`. It returns
64 derived bytes and writes nothing to storage. The Worker parses the passlib hash,
checks its supported scheme/round count, and compares the result in constant time.
The existing bus object is unchanged. No new production namespace or migration.

The primitive is RustCrypto PBKDF2-HMAC-SHA512, compiled to Wasm with no imports or
host crypto calls. The Odoo work factor remains 600,000. This avoids depending on
workerd's native PBKDF2 iteration cap, without weakening the stored hash. Unsupported
hash schemes and rehash cases still raise `NotPorted` as before. There is no Python,
native-crypto or cached-answer fallback.

## Build and provenance

`Cargo.lock` pins the dependency graph; `rust-toolchain.toml` pins Rust 1.90.0.
Run `bash crypto/build.sh` from `worker/` with rustup/cargo installed to rebuild
`src/session/password-kdf.wasm` and the source/artifact SHA-256 manifest. The ordinary
Worker build checks the manifest and uses the included binary, so it does not need
Rust installed. The first experimental build used an isolated toolchain in `/tmp`.
Third-party MIT notices are in `THIRD_PARTY.md`.

The binary is 27,624 bytes. It is imported as a precompiled module, as required by
[Workers](https://developers.cloudflare.com/workers/runtime-apis/webassembly/), and
instantiated only on the first derivation. The Rust wrapper handles memory ownership;
[RustCrypto](https://docs.rs/pbkdf2/0.12.2/pbkdf2/) implements the algorithm. Input/output
buffers in Wasm are zeroed before release. This is not a claim that JavaScript strings
or all engine/stack copies can be erased. The synchronous adapter has no suspension
point between allocating, calculating and freeing memory.

## Local measurements, 2026-10-28

`probes/crypto/` is a separate synthetic Worker, not part of the production router.
It has no database, assets, cron, secret inputs or Odoo code. It compares the same
native and Wasm primitives directly in the Worker and through a SQLite DO RPC.
Only fixed synthetic inputs and 100,000 / 100,001 / 600,000 rounds are accepted.

Start from `worker/`:

```sh
npx wrangler dev --config probes/crypto/wrangler.jsonc --port 8076 --inspector-port 9231
# In another terminal:
node --experimental-transform-types probes/crypto/measure.mjs ../results/cf/crypto-split
```

Measured on this host, 600,000 rounds, median of three warm calls:

| Engine | Node process CPU | workerd Worker HTTP | workerd DO HTTP |
|---|---:|---:|---:|
| Native | 415.6 ms | 367.0 ms | 369.3 ms |
| RustCrypto Wasm | 606.8 ms | 642.1 ms | 645.7 ms |

Wasm is slower here. DO RPC adds little to local latency, but remote latency is
unmeasured. The benefit being tested is a separate compute budget and independence
from native PBKDF2 limits, not faster hashing. Moving Wasm into the ordinary Worker
alone does not solve the Free CPU limit.

All 48 HTTP comparisons matched native derived bytes exactly. Unit tests also cover
Unicode, embedded NUL, binary salts, long HMAC keys, empty inputs, memory growth and
reuse, wrong passwords, passlib adapted base64, and unchanged unsupported-hash errors.
An esbuild dependency-graph test guards against importing the Odoo dispatcher, ORM,
database or external networking libraries into the sessions object.

Raw local evidence: `results/cf/crypto-split-20261028/measurement.json`. These are
Node CPU measurements and workerd HTTP latencies, not Cloudflare billing measurements.
The first-call values are not guaranteed cold starts. Local workerd accepted native
600,000 rounds; that does not establish the hosted native limit. Probe dry-run bundle:
29.88 KiB total / 9.64 KiB gzip. No probe has been deployed.

Final integrated gate: `results/cf/rt-20261028-231311/report.json`, strict S1,
23/23 screens, 412/412 identical HTTP exchanges, matching database diff and no
unexpected requests. This executes browser login and the Contacts path against the
Wasm/DO implementation, not a mocked crypto boundary. Typecheck, 61 Node tests and
4 Python exporter tests passed. Build includes the production Wrangler dry-run.

Integrated local profiles are in `results/cf/cpu-split-20261028/`. The local inspector
includes both Worker and DO activity: warm logins sampled about 642-647 ms inside
Wasm functions and 725-738 ms total non-idle time. The remainder is **not** an exact
ordinary-Worker CPU measurement; it includes wrapper, storage, runtime and inspector
overhead. First Contacts list sampled 123 ms non-idle, with initialization, GC and
connection handling among the frames. These results do not establish Free-plan fit
for the remaining request work. No additional Odoo responsibilities were moved.

## Acceptance still required in Cloudflare

Measure the isolated probe on the owner's verified Free plan, including actual
Worker and DO invocation CPU/outcomes at the iteration boundary. Then measure the
remaining Odoo request work, especially cold module initialization, SQL connection
setup, view processing and Contacts reads. The [Worker CPU budget](https://developers.cloudflare.com/workers/platform/limits/)
and [DO budget](https://developers.cloudflare.com/durable-objects/platform/limits/)
are separate; moving only PBKDF2 does not prove the rest fits. DO request/duration
quotas still apply. No subscription change, paid feature or deployment is authorized
by this local implementation. Full hosted S1, Tunnel and Hyperdrive remain unverified.
