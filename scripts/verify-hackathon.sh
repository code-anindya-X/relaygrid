#!/usr/bin/env bash
set -euo pipefail

RELAYGRID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELAYGRID_ROOT"

services_only=false
if [[ "${1:-}" == "--services-only" ]]; then
  services_only=true
elif [[ -n "${1:-}" ]]; then
  echo "Usage: ./scripts/verify-hackathon.sh [--services-only]"
  exit 2
fi

check_url() {
  local name="$1"
  local url="$2"
  curl --fail --silent --show-error --retry 3 --retry-connrefused --max-time 10 "$url" >/dev/null
  printf 'PASS  %s\n' "$name"
}

check_url "Console" "http://127.0.0.1:5173"
check_url "Impact Engine" "http://127.0.0.1:8002/health"
check_url "Proofline" "http://127.0.0.1:8082/v1/actions/health"
check_url "Operations MCP" "http://127.0.0.1:8083/health"
check_url "Control Plane" "http://127.0.0.1:8084/health"
check_url "TrueForge" "http://localhost:8790/healthz"

impact_health="$(curl --fail --silent --show-error http://127.0.0.1:8002/health)"
if [[ "$impact_health" != *'"store":"postgres"'* ]]; then
  echo "FAIL  Impact Engine is not using the durable PostgreSQL store."
  exit 1
fi
printf 'PASS  PostgreSQL durability\n'

response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
status_code="$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' \
  --header 'content-type: application/json' \
  --data '{"recallId":"HACKATHON-SMOKE-001","supplier":"Demo Supplier","lotIds":["LOT-0001"],"reason":"Hackathon readiness verification"}' \
  http://127.0.0.1:8084/v1/tracehold/recalls)"
if [[ "$status_code" != "202" ]] || ! grep -q '"phase":"awaiting_operator_review"' "$response_file"; then
  echo "FAIL  TraceHold did not prepare an approval-gated action (HTTP $status_code)."
  cat "$response_file"
  exit 1
fi
printf 'PASS  TraceHold end-to-end approval preparation\n'

if [[ "$services_only" == "true" ]]; then
  echo "PASS  Service-only checks complete; TrueForge model and agent checks skipped."
  exit 0
fi

model_count="$(curl --fail --silent --show-error http://localhost:8790/api/v1/models | python3 -c 'import json, sys; print(len(json.load(sys.stdin).get("data", [])))')"
agent_count="$(curl --fail --silent --show-error http://localhost:8790/api/v1/agents | python3 -c 'import json, sys; print(len(json.load(sys.stdin).get("data", [])))')"
if ((model_count < 1)); then
  echo "FAIL  TrueForge has no model. Configure one in Settings -> Models."
  exit 1
fi
if ((agent_count < 1)); then
  echo "FAIL  TrueForge has no agent. Run: npm run trueforge:bootstrap"
  exit 1
fi

printf 'PASS  TrueForge model (%s configured)\n' "$model_count"
printf 'PASS  TrueForge agent (%s configured)\n' "$agent_count"
echo "RelayGrid is ready for the hackathon demo."