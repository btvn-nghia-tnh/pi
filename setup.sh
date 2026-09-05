#!/usr/bin/env bash
#
# Fresh-clone setup for the pi monorepo: install, hydrate model data, build
# the web UI. Safe to re-run (idempotent).
#
#   ./setup.sh                 # everything below
#   ./setup.sh --refresh-models  # re-fetch model data even if it exists
#   ./setup.sh --check         # also run the full repo check (slow)
#
# Requirements: Node.js >= 22.19.0 and internet access for the first run
# (npm install + model catalog from models.dev).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

REFRESH_MODELS=false
RUN_CHECK=false
for arg in "$@"; do
	case "$arg" in
		--refresh-models) REFRESH_MODELS=true ;;
		--check) RUN_CHECK=true ;;
		*)
			echo "Unknown argument: $arg (supported: --refresh-models, --check)" >&2
			exit 1
			;;
	esac
done

log() { printf "\n\033[1;36m== %s\033[0m\n" "$*"; }

# ---------------------------------------------------------------- node check
log "Checking Node.js version (needs >= 22.19.0)"
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 22 ]; then
	echo "ERROR: Node $(node --version) is too old — install Node >= 22.19.0 (e.g. nvm install 22)." >&2
	exit 1
fi
echo "OK: $(node --version)"

# ---------------------------------------------------------------- install
log "Installing dependencies (repo root)"
npm install

# ---------------------------------------------------------------- model data
# packages/ai/src/providers/data/ is gitignored: the model catalog is fetched
# from models.dev. Without it, `pi web` (and anything importing the ai
# package) crashes with ERR_MODULE_NOT_FOUND for data/.manifest.json.
MODEL_DATA_DIR="packages/ai/src/providers/data"
if [ "$REFRESH_MODELS" = true ] || [ ! -f "$MODEL_DATA_DIR/.manifest.json" ]; then
	log "Hydrating model data (fetches from models.dev — needs internet)"
	npm run hydrate:model-data
else
	echo "Model data present ($MODEL_DATA_DIR) — skipping (use --refresh-models to re-fetch)"
fi

# ---------------------------------------------------------------- web UI
# The web GUI bundle is served from packages/web/dist; `pi web` fails with
# "Web UI assets not found" when it is missing.
log "Building the web UI (packages/web)"
npm --prefix packages/web run build

# ---------------------------------------------------------------- optional
if [ "$RUN_CHECK" = true; then
	log "Running full repo check (lint + types + tests + browser smoke)"
	npm run check
fi

log "Done. Start the web UI with:"
echo "  ./pi-test.sh web --no-open --port 8080"
echo "  then open http://127.0.0.1:8080 (token is printed in the log)"
