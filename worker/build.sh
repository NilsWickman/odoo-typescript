#!/usr/bin/env bash
# Track contract (harness/runner.py start_track): build, then start.sh serves on $PORT with GET /health = 200.
set -euo pipefail
cd "$(dirname "$0")"
export NODE_ENV=development
sha256sum --quiet -c crypto/SHA256SUMS # shipped Wasm must match the pinned, rebuildable source
npm install --include=dev --no-audit --no-fund --loglevel=error
if [ ! -d assets/web ]; then ../.venv/bin/python gen/assets.py; fi  # static module trees (gitignored, 59 MB)
python3 gen/filestore.py
npx tsc --noEmit
npx wrangler deploy --dry-run --outdir .wrangler/dry-run >/dev/null
