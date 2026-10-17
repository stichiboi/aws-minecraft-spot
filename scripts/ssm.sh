#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: ssm.sh <instance-id> <command...>}"
shift
COMMAND="$*"

if [[ -z "${COMMAND}" ]]; then
  echo "Usage: ssm.sh <instance-id> <command>" >&2
  exit 1
fi

source "$(dirname "${BASH_SOURCE[0]}")/lib/ssm-run.sh"

echo "Running: ${COMMAND}"
ssm_run "${INSTANCE_ID}" "$(json_array "${COMMAND}")"
