#!/bin/bash
set -euo pipefail

INSTANCE_ID="${1:?Usage: reset-world.sh <instance-id>}"

echo "WARNING: This will permanently delete the Minecraft world on instance ${INSTANCE_ID}."
echo "Folders to be deleted: world/, world_nether/, world_the_end/"
echo ""
read -r -p "Type 'yes' to confirm: " CONFIRM
if [[ "${CONFIRM}" != "yes" ]]; then
  echo "Aborted."
  exit 0
fi

echo ""
echo "▸ Resetting world on instance ${INSTANCE_ID} via SSM..."

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters commands="[
    \"systemctl stop minecraft.service\",
    \"echo 'Service stopped.'\",
    \"rm -rf /opt/minecraft/data/server/world /opt/minecraft/data/server/world_nether /opt/minecraft/data/server/world_the_end\",
    \"echo 'World folders deleted.'\",
    \"systemctl start minecraft.service\",
    \"echo 'Service started.'\"
  ]" \
  --query 'Command.CommandId' \
  --output text)

echo "  SSM command ID: ${COMMAND_ID}"
echo "  Waiting for completion..."

aws ssm wait command-executed \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" 2>/dev/null || true

STATUS=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StatusDetails' \
  --output text)

OUTPUT=$(aws ssm get-command-invocation \
  --command-id "${COMMAND_ID}" \
  --instance-id "${INSTANCE_ID}" \
  --query 'StandardOutputContent' \
  --output text)

echo ""
echo "${OUTPUT}"
echo "▸ Status: ${STATUS}"

if [[ "${STATUS}" != "Success" ]]; then
  STDERR=$(aws ssm get-command-invocation \
    --command-id "${COMMAND_ID}" \
    --instance-id "${INSTANCE_ID}" \
    --query 'StandardErrorContent' \
    --output text)
  echo ""
  echo "STDERR: ${STDERR}" >&2
  exit 1
fi

echo ""
echo "✓ World reset complete. Server is restarting with a fresh world."
echo "  Run 'task logs:server -- --follow' to watch the server come back up."
