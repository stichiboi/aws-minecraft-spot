#!/bin/bash
set -euo pipefail

# Pull Minecraft-related logs from the EC2 instance via SSM (no SSH required).
# Usage: scripts/logs.sh [lines]
#   lines — tail size per file / journal (default: 200)

STACK_NAME="MinecraftServer"
LINES="${1:-200}"

if ! [[ "${LINES}" =~ ^[0-9]+$ ]]; then
  echo "Usage: $0 [lines]" >&2
  echo "  lines — number of lines to tail from each log source (default: 200)" >&2
  exit 1
fi

INSTANCE_ID=$(aws cloudformation describe-stacks \
  --stack-name "${STACK_NAME}" \
  --query 'Stacks[0].Outputs[?OutputKey==`InstanceId`].OutputValue' \
  --output text)

STATE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --query 'Reservations[0].Instances[0].State.Name' \
  --output text)

if [[ "${STATE}" != "running" ]]; then
  echo "Instance ${INSTANCE_ID} is not running (state: ${STATE}). Start it with scripts/start-server.sh" >&2
  exit 1
fi

PARAMS=$(cat <<EOF
{
  "commands": [
    "echo '=== /var/log/minecraft-setup.log (last ${LINES} lines) ==='",
    "tail -n ${LINES} /var/log/minecraft-setup.log 2>/dev/null || echo '(missing)'",
    "echo",
    "echo '=== /var/log/minecraft-boot.log (last ${LINES} lines) ==='",
    "tail -n ${LINES} /var/log/minecraft-boot.log 2>/dev/null || echo '(missing)'",
    "echo",
    "echo '=== minecraft.service (journal, last ${LINES} lines) ==='",
    "journalctl -u minecraft -n ${LINES} --no-pager 2>/dev/null || echo '(journalctl failed)'"
  ]
}
EOF
)

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --comment "Fetch Minecraft server logs" \
  --parameters "${PARAMS}" \
  --query 'Command.CommandId' \
  --output text)

echo "Waiting for SSM command ${COMMAND_ID} on ${INSTANCE_ID}..."
while true; do
  STATUS=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query 'Status' \
    --output text 2>/dev/null || echo "Pending")

  case "${STATUS}" in
    Success | Failed | Cancelled | TimedOut | Undeliverable) break ;;
  esac
  sleep 2
done

OUT=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardOutputContent' \
  --output text)

ERR=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardErrorContent' \
  --output text)

printf '%s' "${OUT}"
if [[ -n "${ERR}" && "${ERR}" != "None" ]]; then
  echo "--- stderr ---" >&2
  printf '%s' "${ERR}" >&2
fi

if [[ "${STATUS}" != "Success" ]]; then
  echo >&2
  echo "SSM command finished with status: ${STATUS}" >&2
  exit 1
fi
