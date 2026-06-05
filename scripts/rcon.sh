#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: rcon.sh <instance-id> <command...>}"
shift
COMMAND="$*"

if [[ -z "${COMMAND}" ]]; then
  echo "Usage: rcon.sh <instance-id> <command>" >&2
  exit 1
fi

echo "RCON: ${COMMAND}"

# Build the remote script. Only ${COMMAND} is expanded here (on the dev machine);
# everything else uses \${...} so it expands on the EC2 instance.
REMOTE_SCRIPT=$(cat <<EOF
set -euo pipefail
SERVER_DIR=/opt/minecraft/data/server
get_prop() {
  grep -E "^\$1=" "\${SERVER_DIR}/server.properties" \\
    | head -1 | cut -d'=' -f2- | tr -d '[:space:]'
}
RCON_PORT=\$(get_prop "rcon.port")
RCON_PASSWORD=\$(get_prop "rcon.password")
RCON_PORT="\${RCON_PORT:-25575}"
if [[ -z "\${RCON_PASSWORD}" ]]; then
  echo "ERROR: rcon.password not set in server.properties" >&2
  exit 1
fi
python3 /opt/minecraft/rcon_query.py "\${RCON_PORT}" "\${RCON_PASSWORD}" "${COMMAND}"
EOF
)

PARAMS=$(python3 -c "import json,sys; print(json.dumps({'commands': [sys.argv[1]]}))" "${REMOTE_SCRIPT}")

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
