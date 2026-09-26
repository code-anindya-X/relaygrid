#!/usr/bin/env bash
set -euo pipefail

RELAYGRID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELAYGRID_ROOT"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example."
fi

mkdir -p .local/logs .local/pids
set -a
# shellcheck disable=SC1091
source .env
set +a

missing=()
[[ -x apps/console/node_modules/.bin/next ]] || missing+=("Console packages")
[[ -x services/control-plane-ts/node_modules/.bin/tsx ]] || missing+=("control-plane packages")
[[ -x services/ops-mcp-ts/node_modules/.bin/tsx ]] || missing+=("Operations MCP packages")
[[ -x services/impact-engine-py/.venv/bin/uvicorn ]] || missing+=("Python impact-engine packages")
[[ -x node_modules/.bin/trueforge ]] || missing+=("TrueForge package")
if ((${#missing[@]} > 0)); then
  echo "Demo dependencies are missing: ${missing[*]}."
  echo "Install them once with: ./scripts/setup-local.sh --demo"
  exit 1
fi

start_service() {
  local service_name="$1"
  local relative_dir="$2"
  local health_url="$3"
  shift 3

  if curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1; then
    echo "${service_name} already reachable at ${health_url}"
    return
  fi
  if [[ -f ".local/pids/${service_name}.pid" ]]; then
    local existing_pid
    existing_pid="$(cat ".local/pids/${service_name}.pid")"
    if kill -0 "$existing_pid" 2>/dev/null; then
      echo "${service_name} already running (PID ${existing_pid})"
      return
    fi
    rm -f ".local/pids/${service_name}.pid"
  fi

  nohup bash -c 'cd "$1"; shift; exec "$@"' _ "$RELAYGRID_ROOT/$relative_dir" "$@" \
    >"$RELAYGRID_ROOT/.local/logs/${service_name}.log" 2>&1 </dev/null &
  local service_pid="$!"
  echo "$service_pid" > ".local/pids/${service_name}.pid"

  for attempt in {1..40}; do
    if curl -fsS --max-time 1 "$health_url" >/dev/null 2>&1; then
      echo "Started ${service_name} (log: .local/logs/${service_name}.log)"
      return
    fi
    if ! kill -0 "$service_pid" 2>/dev/null; then
      echo "${service_name} stopped during startup. Last log lines:"
      tail -n 12 ".local/logs/${service_name}.log" 2>/dev/null || true
      rm -f ".local/pids/${service_name}.pid"
      return
    fi
    sleep 0.25
  done
  echo "${service_name} is still starting; inspect .local/logs/${service_name}.log"
}

start_job() {
  local job_name="$1"
  local relative_dir="$2"
  shift 2
  if [[ -f ".local/pids/${job_name}.pid" ]] && kill -0 "$(cat ".local/pids/${job_name}.pid")" 2>/dev/null; then
    echo "${job_name} already running"
    return
  fi
  nohup bash -c 'cd "$1"; shift; exec "$@"' _ "$RELAYGRID_ROOT/$relative_dir" "$@" \
    >"$RELAYGRID_ROOT/.local/logs/${job_name}.log" 2>&1 </dev/null &
  echo "$!" > ".local/pids/${job_name}.pid"
  echo "Started ${job_name} (log: .local/logs/${job_name}.log)"
}

# DATABASE_URL is blank only for the Python process so it selects its fast,
# stateful in-memory digital twin instead of waiting for an absent PostgreSQL.
start_service impact-engine services/impact-engine-py http://127.0.0.1:8002/health \
  env DATABASE_URL= .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8002
start_service control-plane services/control-plane-ts http://127.0.0.1:8084/health \
  env PORT=8084 IMPACT_ENGINE_URL=http://127.0.0.1:8002 npm run dev
start_service operations-mcp services/ops-mcp-ts http://127.0.0.1:8083/health \
  env IMPACT_ENGINE_URL=http://127.0.0.1:8002 npm run dev
start_service console apps/console http://127.0.0.1:5173 npm run dev
start_service trueforge . http://localhost:8790/healthz npm run trueforge
start_job trueforge-bootstrap . env TRUEFORGE_BOOTSTRAP_WAIT_SECONDS=20 npm run trueforge:bootstrap

echo
echo "RelayGrid demo is available at http://localhost:5173"
echo "TrueForge is available at http://localhost:8790"
echo "Digital twin controls and Console approvals use live in-memory demo state."
echo "Proofline persistence and database-changing MCP tools remain unavailable until the full stack is started."
echo "Stop local processes with ./scripts/dev-down.sh."
