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
RCON_BIN=/usr/local/bin/rcon
if [[ ! -x "\${RCON_BIN}" ]]; then
  echo "Installing rcon..."
  TMP=\$(mktemp -d)
  curl -fsSL https://github.com/gorcon/rcon-cli/releases/download/v0.10.3/rcon-0.10.3-amd64_linux.tar.gz \\
    | tar -xz -C "\${TMP}"
  mv "\${TMP}/rcon-0.10.3-amd64_linux/rcon" "\${RCON_BIN}"
  chmod +x "\${RCON_BIN}"
  rm -rf "\${TMP}"
fi
\${RCON_BIN} --address 127.0.0.1:25575 --password "password" "${COMMAND}"
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
