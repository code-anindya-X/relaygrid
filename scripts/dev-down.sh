#!/usr/bin/env bash
set -euo pipefail

RELAYGRID_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RELAYGRID_ROOT"
for pid_file in .local/pids/*.pid; do
  [[ -f "$pid_file" ]] || continue
  pid="$(cat "$pid_file")"
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pid_file"
done
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  docker compose stop postgres >/dev/null 2>&1 || true
fi
echo "RelayGrid local services stopped. Data remains in the Docker volume."
