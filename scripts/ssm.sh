#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: ssm.sh <instance-id> <command...>}"
shift
COMMAND="$*"

if [[ -z "${COMMAND}" ]]; then
  echo "Usage: ssm.sh <instance-id> <command>" >&2
  exit 1
fi

echo "Running: ${COMMAND}"

PARAMS=$(python3 -c "import json,sys; print(json.dumps({'commands': [sys.argv[1]]}))" "${COMMAND}")

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters "${PARAMS}" \
  --query 'Command.CommandId' \
  --output text)

echo "Waiting for result..."

while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")

  case "${STATUS}" in
    Success|Failed|Cancelled|TimedOut|DeliveryTimedOut|ExecutionTimedOut)
      break
      ;;
    *)
      sleep 2
      ;;
  esac
done

STDOUT=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardOutputContent' \
  --output text)

STDERR=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardErrorContent' \
  --output text)

[[ -n "${STDOUT}" && "${STDOUT}" != "None" ]] && echo "${STDOUT}"
if [[ -n "${STDERR}" && "${STDERR}" != "None" ]]; then
  echo "--- stderr ---" >&2
  echo "${STDERR}" >&2
fi

[[ "${STATUS}" == "Success" ]] || exit 1
