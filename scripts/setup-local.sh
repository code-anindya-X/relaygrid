#!/usr/bin/env bash
set -euo pipefail

RELAYGRID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELAYGRID_ROOT"

mode="full"
case "${1:-}" in
  ""|--full) mode="full" ;;
  --demo) mode="demo" ;;
  -h|--help)
    echo "Usage: ./scripts/setup-local.sh [--full|--demo]"
    echo "  --full  Install everything and start/seed PostgreSQL (default)."
    echo "  --demo  Install Console, TypeScript and Python dependencies only."
    exit 0
    ;;
  *)
    echo "Unknown option: $1"
    echo "Usage: ./scripts/setup-local.sh [--full|--demo]"
    exit 2
    ;;
esac

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example. Local-only tokens are set; replace them before sharing this machine."
fi
set -a
source .env
set +a

npm --prefix apps/console install
npm --prefix services/control-plane-ts install
npm --prefix services/ops-mcp-ts install
npm install

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required for the impact and digital-twin engine."
  exit 1
fi
if [[ ! -x services/impact-engine-py/.venv/bin/python ]]; then
  python3 -m venv services/impact-engine-py/.venv
fi
services/impact-engine-py/.venv/bin/pip install -r services/impact-engine-py/requirements.txt

if [[ "$mode" == "demo" ]]; then
  echo "Demo dependencies installed. Run ./scripts/demo-up.sh."
  echo "Demo mode uses the Python in-memory digital twin and Console action ledger; Docker is not required."
  exit 0
fi

missing=()
if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  missing+=("Docker Compose")
fi
if ((${#missing[@]} > 0)); then
  echo "Full-stack setup still needs: ${missing[*]}."
  echo "This machine can run the functional no-database demo now: ./scripts/demo-up.sh"
  exit 1
fi

docker compose up -d postgres
database_ready=false
for attempt in {1..30}; do
  if docker compose exec -T postgres pg_isready -U "${POSTGRES_USER:-relaygrid}" -d "${POSTGRES_DB:-relaygrid}" >/dev/null 2>&1; then
    database_ready=true
    break
  fi
  sleep 1
done
if [[ "$database_ready" != "true" ]]; then
  echo "PostgreSQL did not become ready within 30 seconds. Check: docker compose logs postgres"
  exit 1
fi
docker compose exec -T postgres psql -U "${POSTGRES_USER:-relaygrid}" -d "${POSTGRES_DB:-relaygrid}" < infra/postgres/seed-demo.sql
echo "Dependencies installed and PostgreSQL started. Run ./scripts/dev-up.sh next."
