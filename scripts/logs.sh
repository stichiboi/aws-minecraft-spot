#!/bin/bash
set -euo pipefail

# Stream Minecraft logs from CloudWatch Logs.
# Usage: scripts/logs.sh <boot|setup|server> [--follow]

declare -A LOG_GROUPS=(
  [boot]="/minecraft/boot"
  [setup]="/minecraft/setup"
  [server]="/minecraft/server"
)

SOURCE="${1:-}"
FOLLOW="${2:-}"

if [[ -z "${SOURCE}" || -z "${LOG_GROUPS[${SOURCE}]+set}" ]]; then
  echo "Usage: $0 <boot|setup|server> [--follow]" >&2
  exit 1
fi

LOG_GROUP="${LOG_GROUPS[${SOURCE}]}"

ARGS=(--log-group-name "${LOG_GROUP}")
if [[ "${FOLLOW}" == "--follow" ]]; then
  ARGS+=(--follow)
fi

aws logs tail "${ARGS[@]}"
