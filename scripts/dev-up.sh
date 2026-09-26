#!/usr/bin/env bash
set -euo pipefail

RELAYGRID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELAYGRID_ROOT"
if [[ ! -f .env ]]; then
  echo "Missing .env. Run ./scripts/setup-local.sh --full first."
  exit 1
fi

mkdir -p .local/logs .local/pids
set -a
# shellcheck disable=SC1091
source .env
set +a

missing=()
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  missing+=("Docker Compose")
fi
if ((${#missing[@]} > 0)); then
  echo "Full-stack start requires: ${missing[*]}."
  echo "Run ./scripts/demo-up.sh for the functional no-database demo."
  exit 1
fi

docker compose up -d postgres

start_service() {
  local service_name="$1"
  local relative_dir="$2"
  shift 2
  if [[ -f ".local/pids/${service_name}.pid" ]] && kill -0 "$(cat ".local/pids/${service_name}.pid")" 2>/dev/null; then
    echo "${service_name} already running"
    return
  fi
  nohup bash -c 'cd "$1"; shift; exec "$@"' _ "$RELAYGRID_ROOT/$relative_dir" "$@" \
    >"$RELAYGRID_ROOT/.local/logs/${service_name}.log" 2>&1 </dev/null &
  echo "$!" > ".local/pids/${service_name}.pid"
  echo "Started ${service_name} (log: .local/logs/${service_name}.log)"
}

start_service console apps/console npm run dev
start_service control-plane services/control-plane-ts npm run dev
start_service impact-engine services/impact-engine-py .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8002
start_service proofline services/proofline-java ./gradlew bootRun
start_service operations-mcp services/ops-mcp-ts npm run dev
start_service trueforge . npm run trueforge
start_service trueforge-bootstrap . npm run trueforge:bootstrap

echo "RelayGrid started. Open the console at http://localhost:5173 and TrueForge at http://localhost:8790."
echo "TrueForge bootstrap registers RelayGrid MCP and creates the agent when a model is configured."
echo "Stop processes with ./scripts/dev-down.sh."
