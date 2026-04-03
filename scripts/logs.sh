#!/bin/bash
set -euo pipefail

# Stream Minecraft logs from CloudWatch Logs.
# Usage: scripts/logs.sh [boot|setup|server] [--follow]
#        Omit source to tail all 3 streams in parallel.

SOURCE="${1:-}"
FOLLOW="${2:-}"

SOURCES=(boot setup server)

tail_group() {
  local source="$1"
  local args=("/minecraft/${source}")
  [[ "${FOLLOW}" == "--follow" ]] && args+=(--follow)
  aws logs tail "${args[@]}"
}

if [[ -z "${SOURCE}" ]]; then
  for s in "${SOURCES[@]}"; do
    tail_group "${s}" &
  done
  wait
  exit 0
fi

case "${SOURCE}" in
  boot|setup|server) tail_group "${SOURCE}" ;;
  *)
    echo "Usage: $0 [boot|setup|server] [--follow]" >&2
    exit 1
    ;;
esac
