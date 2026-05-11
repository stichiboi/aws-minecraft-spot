#!/bin/bash
# Syncs mod JARs and mod configs from S3 to the running EC2 instance via SSM.
# Does NOT restart the service — use restart-server.sh for that.
#
# Usage: sync-mods.sh <instance-id> <bucket-name>
set -euo pipefail

INSTANCE_ID="${1:?Usage: sync-mods.sh <instance-id> <bucket-name>}"
BUCKET_NAME="${2:?Usage: sync-mods.sh <instance-id> <bucket-name>}"

echo "▸ Syncing mods on instance ${INSTANCE_ID} via SSM..."

COMMAND_ID=$(aws ssm send-command \
  --instance-ids "${INSTANCE_ID}" \
  --document-name "AWS-RunShellScript" \
  --parameters commands="[
    \"aws s3 sync s3://${BUCKET_NAME}/mods/ /opt/minecraft/data/server/mods/ --delete\",
    \"aws s3 sync s3://${BUCKET_NAME}/mods-config/ /opt/minecraft/data/server/config/ --delete\",
    \"aws s3 sync s3://${BUCKET_NAME}/datapacks/ /opt/minecraft/data/server/world/datapacks/ --delete\",
    \"chown -R minecraft:minecraft /opt/minecraft/data/server/mods /opt/minecraft/data/server/config\",
    \"chown -R minecraft:minecraft /opt/minecraft/data/server/world/datapacks\",
    \"echo 'Mods and datapacks synced.'\"
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
echo "✓ Mods synced to instance."
